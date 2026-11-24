import { Worker } from 'node:worker_threads';

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export interface DbWorkerStats {
  isMainThread: boolean;
  workspaces: number;
  vaultProviders: number;
  cachedBars: number;
}

export class DbWorkerClient {
  private readonly worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();

  constructor(dbPath: string) {
    const workerUrl = new URL('./db-compute.worker.ts', import.meta.url);
    this.worker = new Worker(workerUrl, {
      workerData: { dbPath },
    });

    this.worker.on('message', (msg: { id: number; ok: boolean; result?: unknown; error?: string }) => {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.ok) {
        entry.resolve(msg.result);
      } else {
        entry.reject(new Error(msg.error ?? 'Worker error'));
      }
    });

    this.worker.on('error', (err) => {
      for (const [, p] of this.pending) {
        p.reject(err);
      }
      this.pending.clear();
    });
  }

  private call<T>(payload: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.worker.postMessage({ ...payload, id });
    });
  }

  ping(): Promise<{ ok: boolean; isMainThread: boolean; walMode: Record<string, unknown> }> {
    return this.call({ op: 'ping' });
  }

  stats(): Promise<DbWorkerStats> {
    return this.call({ op: 'stats' });
  }

  putVaultSecret(provider: string, recordJson: string): Promise<{ ok: boolean }> {
    return this.call({ op: 'vault.put', provider, recordJson, updatedAt: Date.now() });
  }

  getVaultSecret(provider: string): Promise<{ record_json: string; updated_at: number } | null> {
    return this.call({ op: 'vault.get', provider });
  }

  listVaultProviders(): Promise<Array<{ provider: string; updated_at: number }>> {
    return this.call({ op: 'vault.list' });
  }

  deleteVaultSecret(provider: string): Promise<{ ok: boolean }> {
    return this.call({ op: 'vault.delete', provider });
  }

  saveWorkspace(
    workspaceId: string,
    name: string,
    revision: number,
    snapshotJson: string,
  ): Promise<{ ok: boolean }> {
    return this.call({
      op: 'workspace.save',
      workspaceId,
      name,
      revision,
      snapshotJson,
      updatedAt: Date.now(),
    });
  }

  loadWorkspace(workspaceId: string): Promise<{
    id: string;
    name: string;
    revision: number;
    snapshot_json: string;
    updated_at: number;
  } | null> {
    return this.call({ op: 'workspace.load', workspaceId });
  }

  listWorkspaces(): Promise<Array<{ id: string; name: string; revision: number; updated_at: number }>> {
    return this.call({ op: 'workspace.list' });
  }

  putBarsBatch(
    symbol: string,
    resolution: string,
    bars: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>,
  ): Promise<{ ok: boolean; count: number }> {
    return this.call({ op: 'bars.putBatch', symbol, resolution, bars });
  }

  getCachedBars(
    symbol: string,
    resolution: string,
    limit: number,
    beforeTime?: number,
  ): Promise<Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>> {
    return this.call({
      op: 'bars.getRange',
      symbol,
      resolution,
      limit,
      ...(beforeTime !== undefined ? { beforeTime } : {}),
    });
  }

  invalidateCachedBars(symbol: string): Promise<{ ok: boolean }> {
    return this.call({ op: 'bars.invalidate', symbol });
  }

  async close(): Promise<void> {
    await this.worker.terminate();
  }
}
