import { useEffect, useState } from 'react';
import { loadBrowserWasm } from '@openview/script-runtime';

const BRIDGE_HTTP = 'http://127.0.0.1:4001';
const BRIDGE_WS = 'ws://127.0.0.1:4001/ws';

interface BridgeStatus {
  mode: 'connecting' | 'local_bridge' | 'static_mode';
  vaultMode?: string;
  wsRttMs?: number;
  sqliteOffMainThread?: boolean;
}

export function App() {
  const [bridge, setBridge] = useState<BridgeStatus>({ mode: 'connecting' });
  const [wasmVer, setWasmVer] = useState<string>('loading...');

  useEffect(() => {
    let active = true;
    let socket: WebSocket | null = null;

    loadBrowserWasm()
      .then((s) => {
        if (active) setWasmVer(`v${s.version} ready`);
      })
      .catch(() => {
        if (active) setWasmVer('not built yet');
      });

    async function connectBridge() {
      try {
        const healthRes = await fetch(`${BRIDGE_HTTP}/api/health`, { credentials: 'include' });
        if (!healthRes.ok) throw new Error('Bridge unhealthy');
        const health = (await healthRes.json()) as {
          vaultMode: string;
          sqliteOffMainThread: boolean;
        };

        const sessRes = await fetch(`${BRIDGE_HTTP}/api/v1/auth/session`, {
          method: 'POST',
          credentials: 'include',
        });
        const { token } = (await sessRes.json()) as { token: string };

        const ticketRes = await fetch(`${BRIDGE_HTTP}/api/v1/auth/ws-ticket`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'x-openview-token': token },
        });
        const { ticket } = (await ticketRes.json()) as { ticket: string };

        socket = new WebSocket(`${BRIDGE_WS}?ticket=${encodeURIComponent(ticket)}`);
        socket.onopen = () => {
          socket?.send(JSON.stringify({ type: 'ping', id: 1, ts: performance.now() }));
        };
        socket.onmessage = (ev) => {
          const msg = JSON.parse(String(ev.data)) as { type: string; clientTs?: number };
          if (msg.type === 'pong' && typeof msg.clientTs === 'number' && active) {
            setBridge({
              mode: 'local_bridge',
              vaultMode: health.vaultMode,
              sqliteOffMainThread: health.sqliteOffMainThread,
              wsRttMs: Math.max(0.1, Number((performance.now() - msg.clientTs).toFixed(1))),
            });
          }
        };
        socket.onerror = () => {
          if (active) setBridge({ mode: 'static_mode' });
        };
      } catch {
        if (active) setBridge({ mode: 'static_mode' });
      }
    }

    void connectBridge();
    return () => {
      active = false;
      socket?.close();
    };
  }, []);

  return (
    <div className="flex h-full w-full flex-col bg-[#0b0e14] text-[#d1d4dc]">
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-[#2a2e39] bg-[#131722] px-3 text-xs">
        <div className="flex items-center gap-3">
          <span className="font-semibold tracking-tight text-white">OpenView</span>
          <span className="rounded bg-[#2962ff]/20 px-1.5 py-0.5 font-mono text-[10px] text-[#6aa0ff]">
            PHASE 0 · FOUNDATION
          </span>
        </div>
        <div className="flex items-center gap-4 font-mono text-[11px]">
          <span className="text-[#787b86]">
            WASM: <span className="text-[#d1d4dc]">{wasmVer}</span>
          </span>
          {bridge.mode === 'local_bridge' ? (
            <span className="flex items-center gap-1.5 text-[#089981]">
              <span className="h-2 w-2 rounded-full bg-[#089981]" />
              BRIDGE LIVE ({bridge.wsRttMs}ms · {bridge.vaultMode})
            </span>
          ) : bridge.mode === 'static_mode' ? (
            <span className="flex items-center gap-1.5 text-[#f7931a]">
              <span className="h-2 w-2 rounded-full bg-[#f7931a]" />
              STATIC MODE (Bridge Offline)
            </span>
          ) : (
            <span className="text-[#787b86]">CONNECTING...</span>
          )}
        </div>
      </header>
      <main className="flex flex-1 items-center justify-center p-6">
        <div className="max-w-lg rounded-lg border border-[#2a2e39] bg-[#131722] p-6 text-sm">
          <h1 className="mb-2 text-base font-semibold text-white">
            OpenView Workspace Foundation Ready
          </h1>
          <p className="text-[#787b86]">
            Secured local Node 24 bridge, worker-isolated WAL SQLite, DPAPI/AES-256-GCM vault, and
            Rust/WASM runtime initialized. Phase 1 mounts the clean-room 120 FPS Canvas 2D chart
            core here.
          </p>
        </div>
      </main>
    </div>
  );
}
