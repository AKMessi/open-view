import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBridgeServer, type RunningBridgeServer } from '../app.ts';
import { CSRF_HEADER_NAME } from '../security/guard.ts';
import { PassphraseRamSealer } from '../security/vault.ts';

describe('Phase 2 — Bridge Market API, Encrypted Vault CRUD & SQLite Bar Cache', () => {
  let tmpDir: string;
  let bridge: RunningBridgeServer;
  let token: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openview-p2-'));
    bridge = await createBridgeServer({
      host: '127.0.0.1',
      port: 0,
      webPort: 5173,
      dbPath: path.join(tmpDir, 'p2.sqlite'),
      vaultKeyPath: path.join(tmpDir, 'vault.master.bin'),
      sealer: new PassphraseRamSealer('phase2-strong-passphrase', Buffer.from('p2-salt')),
    });

    const sessRes = await fetch(`${bridge.url}/api/v1/auth/session`, {
      method: 'POST',
      headers: { Origin: 'http://127.0.0.1:5173' },
    });
    const body = (await sessRes.json()) as { token: string };
    token = body.token;
  });

  afterAll(async () => {
    await bridge.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stores provider credentials encrypted in Vault and never returns plaintext secrets', async () => {
    const putRes = await fetch(`${bridge.url}/api/v1/vault/providers/upstox`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://127.0.0.1:5173',
        [CSRF_HEADER_NAME]: token,
      },
      body: JSON.stringify({ accessToken: 'super-secret-upstox-jwt-999' }),
    });
    expect(putRes.status).toBe(200);

    const listRes = await fetch(`${bridge.url}/api/v1/vault/providers`, {
      headers: { Origin: 'http://127.0.0.1:5173', [CSRF_HEADER_NAME]: token },
    });
    const rawText = await listRes.text();
    expect(rawText).not.toContain('super-secret-upstox-jwt-999');

    const parsed = JSON.parse(rawText) as {
      providers: Array<{ id: string; configured: boolean }>;
    };
    const upstox = parsed.providers.find((p) => p.id === 'upstox');
    expect(upstox?.configured).toBe(true);

    const delRes = await fetch(`${bridge.url}/api/v1/vault/providers/upstox`, {
      method: 'DELETE',
      headers: { Origin: 'http://127.0.0.1:5173', [CSRF_HEADER_NAME]: token },
    });
    expect(delRes.status).toBe(200);
  });

  it('searches all 4 target markets via /api/v1/symbols/search', async () => {
    const res = await fetch(`${bridge.url}/api/v1/symbols/search?q=NIFTY&market=india_nse`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { symbols: Array<{ id: string }> };
    expect(data.symbols.some((s) => s.id === 'NSE:NIFTY')).toBe(true);
    expect(data.symbols.some((s) => s.id === 'NSE:NIFTY1!')).toBe(true);
  });

  it('persists workspaces and OHLCV bars cleanly inside off-main-thread SQLite WAL', async () => {
    const saveRes = await fetch(`${bridge.url}/api/v1/workspaces/default`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://127.0.0.1:5173',
        [CSRF_HEADER_NAME]: token,
      },
      body: JSON.stringify({ id: 'default', name: 'Main Desk', revision: 2, theme: 'dark' }),
    });
    expect(saveRes.status).toBe(200);

    const loadRes = await fetch(`${bridge.url}/api/v1/workspaces/default`, {
      headers: { Origin: 'http://127.0.0.1:5173', [CSRF_HEADER_NAME]: token },
    });
    const loaded = (await loadRes.json()) as { workspace: { name: string; revision: number } };
    expect(loaded.workspace.name).toBe('Main Desk');
    expect(loaded.workspace.revision).toBe(2);

    await bridge.db.putBarsBatch('NSE:RELIANCE', '1D', [
      { time: 1000, open: 1300, high: 1320, low: 1290, close: 1315, volume: 10000 },
      { time: 2000, open: 1315, high: 1340, low: 1310, close: 1335, volume: 12000 },
      { time: 3000, open: 1335, high: 1350, low: 1330, close: 1345, volume: 14000 },
    ]);
    const page = await bridge.db.getCachedBars('NSE:RELIANCE', '1D', 2, 3000);
    expect(page).toHaveLength(2);
    expect(page[0]!.time).toBe(1000);
    expect(page[1]!.time).toBe(2000);

    await bridge.db.invalidateCachedBars('NSE:RELIANCE');
    const afterInv = await bridge.db.getCachedBars('NSE:RELIANCE', '1D', 10);
    expect(afterInv).toHaveLength(0);
  });
});
