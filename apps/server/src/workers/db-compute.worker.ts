import { parentPort, workerData, isMainThread } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

if (isMainThread || !parentPort) {
  throw new Error('db-compute.worker.ts must run exclusively inside a worker_threads Worker');
}

interface WorkerInitData {
  dbPath: string;
}

type WorkerRequest =
  | { id: number; op: 'ping' }
  | { id: number; op: 'stats' }
  | { id: number; op: 'vault.put'; provider: string; recordJson: string; updatedAt: number }
  | { id: number; op: 'vault.get'; provider: string }
  | { id: number; op: 'vault.list' }
  | { id: number; op: 'vault.delete'; provider: string }
  | { id: number; op: 'workspace.save'; workspaceId: string; name: string; revision: number; snapshotJson: string; updatedAt: number }
  | { id: number; op: 'workspace.load'; workspaceId: string }
  | { id: number; op: 'workspace.list' }
  | {
      id: number;
      op: 'bars.putBatch';
      symbol: string;
      resolution: string;
      bars: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>;
    }
  | {
      id: number;
      op: 'bars.getRange';
      symbol: string;
      resolution: string;
      beforeTime?: number;
      limit: number;
    }
  | { id: number; op: 'bars.invalidate'; symbol: string };

const init = workerData as WorkerInitData;
if (init.dbPath !== ':memory:') {
  fs.mkdirSync(path.dirname(init.dbPath), { recursive: true });
}

const db = new DatabaseSync(init.dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    snapshot_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS vault_secrets (
    provider TEXT PRIMARY KEY,
    record_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bars_cache (
    symbol TEXT NOT NULL,
    resolution TEXT NOT NULL,
    bar_time INTEGER NOT NULL,
    open REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    close REAL NOT NULL,
    volume REAL NOT NULL,
    PRIMARY KEY (symbol, resolution, bar_time)
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS corporate_actions (
    symbol TEXT NOT NULL,
    ex_date TEXT NOT NULL,
    action_type TEXT NOT NULL,
    factor REAL NOT NULL,
    PRIMARY KEY (symbol, ex_date, action_type)
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    rule_json TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
`);

const stmtVaultPut = db.prepare(
  'INSERT INTO vault_secrets (provider, record_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(provider) DO UPDATE SET record_json = excluded.record_json, updated_at = excluded.updated_at',
);
const stmtVaultGet = db.prepare('SELECT record_json, updated_at FROM vault_secrets WHERE provider = ?');
const stmtVaultList = db.prepare('SELECT provider, updated_at FROM vault_secrets ORDER BY provider ASC');
const stmtVaultDelete = db.prepare('DELETE FROM vault_secrets WHERE provider = ?');

const stmtWsSave = db.prepare(
  'INSERT INTO workspaces (id, name, revision, snapshot_json, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, revision = excluded.revision, snapshot_json = excluded.snapshot_json, updated_at = excluded.updated_at',
);
const stmtWsLoad = db.prepare('SELECT id, name, revision, snapshot_json, updated_at FROM workspaces WHERE id = ?');
const stmtWsList = db.prepare('SELECT id, name, revision, updated_at FROM workspaces ORDER BY updated_at DESC');

const stmtBarUpsert = db.prepare(
  'INSERT INTO bars_cache (symbol, resolution, bar_time, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(symbol, resolution, bar_time) DO UPDATE SET open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close, volume=excluded.volume',
);
const stmtBarsLatest = db.prepare(
  'SELECT bar_time AS time, open, high, low, close, volume FROM bars_cache WHERE symbol = ? AND resolution = ? ORDER BY bar_time DESC LIMIT ?',
);
const stmtBarsBefore = db.prepare(
  'SELECT bar_time AS time, open, high, low, close, volume FROM bars_cache WHERE symbol = ? AND resolution = ? AND bar_time < ? ORDER BY bar_time DESC LIMIT ?',
);
const stmtBarsInvalidate = db.prepare('DELETE FROM bars_cache WHERE symbol = ?');

const port = parentPort;

port.on('message', (req: WorkerRequest) => {
  try {
    let result: unknown;
    switch (req.op) {
      case 'ping':
        result = { ok: true, isMainThread, walMode: db.prepare('PRAGMA journal_mode').get() };
        break;
      case 'stats': {
        const wsCount = db.prepare('SELECT COUNT(*) AS c FROM workspaces').get() as { c: number };
        const vaultCount = db.prepare('SELECT COUNT(*) AS c FROM vault_secrets').get() as { c: number };
        const barCount = db.prepare('SELECT COUNT(*) AS c FROM bars_cache').get() as { c: number };
        result = {
          isMainThread,
          workspaces: wsCount.c,
          vaultProviders: vaultCount.c,
          cachedBars: barCount.c,
        };
        break;
      }
      case 'vault.put':
        stmtVaultPut.run(req.provider, req.recordJson, req.updatedAt);
        result = { ok: true };
        break;
      case 'vault.get':
        result = stmtVaultGet.get(req.provider) ?? null;
        break;
      case 'vault.list':
        result = stmtVaultList.all();
        break;
      case 'vault.delete':
        stmtVaultDelete.run(req.provider);
        result = { ok: true };
        break;
      case 'workspace.save':
        stmtWsSave.run(req.workspaceId, req.name, req.revision, req.snapshotJson, req.updatedAt);
        result = { ok: true };
        break;
      case 'workspace.load':
        result = stmtWsLoad.get(req.workspaceId) ?? null;
        break;
      case 'workspace.list':
        result = stmtWsList.all();
        break;
      case 'bars.putBatch':
        db.exec('BEGIN IMMEDIATE');
        try {
          for (const b of req.bars) {
            stmtBarUpsert.run(req.symbol, req.resolution, b.time, b.open, b.high, b.low, b.close, b.volume);
          }
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
        result = { ok: true, count: req.bars.length };
        break;
      case 'bars.getRange': {
        const rows =
          req.beforeTime !== undefined
            ? stmtBarsBefore.all(req.symbol, req.resolution, req.beforeTime, req.limit)
            : stmtBarsLatest.all(req.symbol, req.resolution, req.limit);
        rows.reverse();
        result = rows;
        break;
      }
      case 'bars.invalidate':
        stmtBarsInvalidate.run(req.symbol);
        result = { ok: true };
        break;
    }
    port.postMessage({ id: req.id, ok: true, result });
  } catch (err) {
    port.postMessage({
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
