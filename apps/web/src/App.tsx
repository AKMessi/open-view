import { useEffect, useRef, useState } from 'react';
import {
  ChartController,
  DEMO_SYMBOLS,
  generateSyntheticBars,
  type FrameTelemetry,
} from '@openview/chart-engine';
import type { ChartStyle, PriceScaleMode, Resolution } from '@openview/protocol';
import { loadBrowserWasm, type WasmRuntimeApi } from '@openview/script-runtime';

const BRIDGE_HTTP = 'http://127.0.0.1:4001';
const BRIDGE_WS = 'ws://127.0.0.1:4001/ws';

const RESOLUTIONS: Resolution[] = ['1', '5', '15', '60', '240', '1D'];
const STYLES: Array<{ id: ChartStyle; label: string }> = [
  { id: 'candles', label: 'Candles' },
  { id: 'hollow_candles', label: 'Hollow' },
  { id: 'bars', label: 'Bars' },
  { id: 'line', label: 'Line' },
  { id: 'step_line', label: 'Step' },
  { id: 'area', label: 'Area' },
  { id: 'baseline', label: 'Baseline' },
  { id: 'heikin_ashi', label: 'Heikin Ashi' },
];
const SCALE_MODES: Array<{ id: PriceScaleMode; label: string }> = [
  { id: 'linear', label: 'Lin' },
  { id: 'symlog', label: 'Log' },
  { id: 'percentage', label: '%' },
  { id: 'indexed_to_100', label: '100' },
];

interface BridgeStatus {
  mode: 'connecting' | 'local_bridge' | 'static_mode';
  vaultMode?: string;
  wsRttMs?: number;
}

export function App() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<ChartController | null>(null);
  const wasmRef = useRef<WasmRuntimeApi | null>(null);

  const [bridge, setBridge] = useState<BridgeStatus>({ mode: 'connecting' });
  const [wasmVer, setWasmVer] = useState<string>('loading...');
  const [symbolId, setSymbolId] = useState<string>('BINANCE:BTCUSDT');
  const [resolution, setResolution] = useState<Resolution>('15');
  const [chartStyle, setChartStyle] = useState<ChartStyle>('candles');
  const [scaleMode, setScaleMode] = useState<PriceScaleMode>('linear');
  const [inverted, setInverted] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [showRsiPane, setShowRsiPane] = useState(true);
  const [stress250k, setStress250k] = useState(false);
  const [telemetry, setTelemetry] = useState<FrameTelemetry | null>(null);

  const symbol = DEMO_SYMBOLS[symbolId] ?? DEMO_SYMBOLS['BINANCE:BTCUSDT']!;

  // Boot WASM + Bridge status
  useEffect(() => {
    let active = true;
    let socket: WebSocket | null = null;

    loadBrowserWasm()
      .then((api) => {
        if (!active) return;
        wasmRef.current = api;
        setWasmVer(`v${api.version}`);
      })
      .catch(() => {
        if (active) setWasmVer('unavailable');
      });

    async function connectBridge() {
      try {
        const healthRes = await fetch(`${BRIDGE_HTTP}/api/health`, { credentials: 'include' });
        if (!healthRes.ok) throw new Error('unhealthy');
        const health = (await healthRes.json()) as { vaultMode: string };

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

  // Mount Clean-Room Canvas 2D Chart Controller
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ctrl = new ChartController({
      symbol,
      resolution,
      chartStyle,
      priceScaleMode: scaleMode,
      theme,
    });
    ctrl.mount(el);
    controllerRef.current = ctrl;

    const timer = window.setInterval(() => {
      setTelemetry(ctrl.getTelemetry());
    }, 300);

    return () => {
      window.clearInterval(timer);
      ctrl.destroy();
      controllerRef.current = null;
    };
    // Mount once on boot; reactive updates use imperative controller methods
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push symbol / resolution / dataset changes imperatively (zero React render hot-path)
  useEffect(() => {
    const ctrl = controllerRef.current;
    if (!ctrl) return;
    ctrl.setSymbolInfo(symbol, resolution);
    const barCount = stress250k ? 250_000 : 2_000;
    const bars = generateSyntheticBars(symbol, resolution, barCount, symbolId.length * 13);
    ctrl.setBars(bars, stress250k ? 250_000 : 140);

    if (showRsiPane) {
      ctrl.addSubPane('rsi14', 0.24, 2);
      const closes = new Float64Array(bars.length);
      for (let i = 0; i < bars.length; i++) closes[i] = bars[i]!.close;
      loadBrowserWasm()
        .then((api) => {
          const rsi = api.taRsi(closes, 14);
          ctrl.setSubPanePlots(
            'rsi14',
            [
              {
                id: 'rsi14',
                title: 'RSI (14)',
                color: '#7e57c2',
                kind: 'line',
                startBarIndex: 0,
                values: rsi,
                refLines: [30, 70],
              },
            ],
            [0, 100],
          );
        })
        .catch(() => {});
    } else {
      ctrl.removeSubPane('rsi14');
    }
  }, [symbol, symbolId, resolution, showRsiPane, stress250k]);

  useEffect(() => {
    controllerRef.current?.setChartStyle(chartStyle);
  }, [chartStyle]);

  useEffect(() => {
    controllerRef.current?.setPriceScaleMode(scaleMode);
  }, [scaleMode]);

  useEffect(() => {
    controllerRef.current?.setInverted(inverted);
  }, [inverted]);

  useEffect(() => {
    controllerRef.current?.setTheme(theme);
  }, [theme]);

  // TradingView-parity keyboard shortcuts
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.altKey && ev.key.toLowerCase() === 'l') {
        ev.preventDefault();
        setScaleMode((m) => (m === 'symlog' ? 'linear' : 'symlog'));
      } else if (ev.altKey && ev.key.toLowerCase() === 'i') {
        ev.preventDefault();
        setInverted((v) => !v);
      } else if (ev.altKey && ev.key.toLowerCase() === 'r') {
        ev.preventDefault();
        controllerRef.current?.resetView();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleSnapshot = () => {
    const url = controllerRef.current?.exportSnapshotDataUrl();
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = `openview-${symbol.ticker}-${resolution}.png`;
    a.click();
  };

  const isDark = theme === 'dark';

  return (
    <div
      className={`flex h-full w-full flex-col ${
        isDark ? 'bg-[#0b0e14] text-[#d1d4dc]' : 'bg-[#f8f9fd] text-[#131722]'
      }`}
    >
      <header
        className={`flex h-11 shrink-0 items-center justify-between gap-2 border-b px-3 text-xs ${
          isDark ? 'border-[#2a2e39] bg-[#131722]' : 'border-[#e0e3eb] bg-white'
        }`}
      >
        <div className="flex items-center gap-2 overflow-x-auto">
          <span className="font-bold tracking-tight text-[#2962ff]">OpenView</span>

          {/* Symbol Switcher across all 4 target markets */}
          <select
            value={symbolId}
            onChange={(e) => setSymbolId(e.target.value)}
            className={`rounded border px-2 py-1 font-mono text-xs font-semibold outline-none ${
              isDark
                ? 'border-[#2a2e39] bg-[#1e222d] text-white'
                : 'border-[#d1d4dc] bg-[#f0f3fa] text-[#131722]'
            }`}
          >
            {Object.values(DEMO_SYMBOLS).map((s) => (
              <option key={s.id} value={s.id}>
                {s.exchange}:{s.ticker} ({s.market})
              </option>
            ))}
          </select>

          <div className="h-4 w-px bg-[#2a2e39]" />

          {/* Timeframes */}
          <div className="flex items-center gap-0.5">
            {RESOLUTIONS.map((r) => (
              <button
                key={r}
                onClick={() => setResolution(r)}
                className={`rounded px-1.5 py-1 font-mono text-[11px] transition ${
                  resolution === r
                    ? 'bg-[#2962ff] text-white'
                    : isDark
                      ? 'text-[#868993] hover:bg-[#1e222d] hover:text-white'
                      : 'text-[#6a6d78] hover:bg-[#f0f3fa] hover:text-[#131722]'
                }`}
              >
                {r === '60' ? '1H' : r === '240' ? '4H' : r === '1D' ? '1D' : `${r}m`}
              </button>
            ))}
          </div>

          <div className="h-4 w-px bg-[#2a2e39]" />

          {/* Chart Style */}
          <select
            value={chartStyle}
            onChange={(e) => setChartStyle(e.target.value as ChartStyle)}
            className={`rounded border px-1.5 py-1 text-[11px] outline-none ${
              isDark
                ? 'border-[#2a2e39] bg-[#1e222d] text-[#d1d4dc]'
                : 'border-[#d1d4dc] bg-[#f0f3fa] text-[#131722]'
            }`}
          >
            {STYLES.map((st) => (
              <option key={st.id} value={st.id}>
                {st.label}
              </option>
            ))}
          </select>

          {/* Scale Modes */}
          <div className="flex items-center gap-0.5">
            {SCALE_MODES.map((m) => (
              <button
                key={m.id}
                onClick={() => setScaleMode(m.id)}
                className={`rounded px-1.5 py-1 font-mono text-[11px] ${
                  scaleMode === m.id
                    ? 'bg-[#2962ff]/25 text-[#5b9cf6]'
                    : 'text-[#787b86] hover:bg-[#1e222d]'
                }`}
              >
                {m.label}
              </button>
            ))}
            <button
              onClick={() => setInverted((v) => !v)}
              className={`rounded px-1.5 py-1 font-mono text-[11px] ${
                inverted ? 'bg-[#f23645]/25 text-[#f23645]' : 'text-[#787b86] hover:bg-[#1e222d]'
              }`}
              title="Invert Price Scale (Alt+I)"
            >
              Inv
            </button>
          </div>

          <div className="h-4 w-px bg-[#2a2e39]" />

          <button
            onClick={() => setShowRsiPane((v) => !v)}
            className={`rounded px-2 py-1 text-[11px] font-medium ${
              showRsiPane ? 'bg-[#7e57c2]/25 text-[#b39ddb]' : 'text-[#787b86] hover:bg-[#1e222d]'
            }`}
          >
            RSI(14) WASM
          </button>

          <button
            onClick={() => setStress250k((v) => !v)}
            className={`rounded px-2 py-1 font-mono text-[11px] ${
              stress250k ? 'bg-[#089981]/25 text-[#089981]' : 'text-[#787b86] hover:bg-[#1e222d]'
            }`}
          >
            {stress250k ? '250k Bars ON' : '250k Stress'}
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-2 font-mono text-[11px]">
          {telemetry && (
            <span className="hidden text-[#787b86] lg:inline">
              {telemetry.medianFrameMs}ms · {telemetry.drawnBars}/{telemetry.totalBars.toLocaleString()} (x
              {telemetry.mipmapStride}) · {telemetry.dpr}x
            </span>
          )}
          <button
            onClick={handleSnapshot}
            className="rounded border border-[#2a2e39] px-2 py-1 text-[11px] hover:bg-[#1e222d]"
            title="Export PNG Snapshot"
          >
            PNG
          </button>
          <button
            onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
            className="rounded border border-[#2a2e39] px-2 py-1 text-[11px] hover:bg-[#1e222d]"
          >
            {isDark ? 'Light' : 'Dark'}
          </button>
          <span className="hidden text-[#787b86] md:inline">WASM {wasmVer}</span>
          <span
            className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${
              bridge.mode === 'local_bridge'
                ? 'bg-[#089981]/15 text-[#089981]'
                : 'bg-[#f7931a]/15 text-[#f7931a]'
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                bridge.mode === 'local_bridge' ? 'bg-[#089981]' : 'bg-[#f7931a]'
              }`}
            />
            {bridge.mode === 'local_bridge' ? `BRIDGE ${bridge.wsRttMs}ms` : 'STATIC'}
          </span>
        </div>
      </header>

      {/* Main 2-Canvas Clean-Room Chart Tile */}
      <main className="relative flex-1 overflow-hidden">
        <div ref={containerRef} className="h-full w-full" />
      </main>
    </div>
  );
}
