import { useEffect, useRef, useState } from 'react';
import {
  ChartController,
  generateSyntheticBars,
  type FrameTelemetry,
} from '@openview/chart-engine';
import {
  DEFAULT_WATCHLIST_IDS,
  findSymbolById,
  parseCsvBars,
  parseParquetBars,
} from '@openview/datafeed-sdk';
import type {
  ChartStyle,
  FeedQualityBadge,
  OHLCVBar,
  PriceScaleMode,
  QuoteTick,
  Resolution,
  SymbolInfo,
  WorkspaceSnapshot,
} from '@openview/protocol';
import { loadBrowserWasm } from '@openview/script-runtime';
import { ProviderVaultModal } from './modals/ProviderVaultModal.tsx';
import { SymbolSearchModal } from './modals/SymbolSearchModal.tsx';
import { WatchlistPanel } from './panels/WatchlistPanel.tsx';
import { MarketClient, type BridgeConnectionState } from './services/market-client.ts';
import { loadWorkspaceLocal, saveWorkspaceLocal } from './storage/workspace-store.ts';

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

function badgeMeta(quality: FeedQualityBadge): { label: string; cls: string } {
  switch (quality) {
    case 'live_full_vol':
      return { label: 'LIVE · FULL VOL', cls: 'bg-[#089981]/15 text-[#089981]' };
    case 'live_subset_vol':
      return { label: 'LIVE · SUBSET VOL', cls: 'bg-[#2962ff]/20 text-[#6aa0ff]' };
    case 'live_quote_zero_vol':
      return { label: 'LIVE · QUOTE / ZERO VOL', cls: 'bg-[#b39ddb]/20 text-[#b39ddb]' };
    case 'replay':
      return { label: 'REPLAY', cls: 'bg-[#f7931a]/20 text-[#f7931a]' };
    case 'delayed_eod':
    default:
      return { label: 'DELAYED / EOD', cls: 'bg-[#f7931a]/15 text-[#f7931a]' };
  }
}

export function App() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<ChartController | null>(null);
  const clientRef = useRef<MarketClient | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const quoteBufferRef = useRef<Record<string, QuoteTick>>({});

  const [bridge, setBridge] = useState<BridgeConnectionState>({ mode: 'connecting' });
  const [symbol, setSymbol] = useState<SymbolInfo>(() => findSymbolById('BINANCE:BTCUSDT')!);
  const [resolution, setResolution] = useState<Resolution>('15');
  const [chartStyle, setChartStyle] = useState<ChartStyle>('candles');
  const [scaleMode, setScaleMode] = useState<PriceScaleMode>('linear');
  const [inverted, setInverted] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [showRsiPane, setShowRsiPane] = useState(true);
  const [showWatchlist, setShowWatchlist] = useState(true);
  const [stress250k, setStress250k] = useState(false);
  const [providerLabel, setProviderLabel] = useState<string>('Connecting...');
  const [telemetry, setTelemetry] = useState<FrameTelemetry | null>(null);
  const [quotes, setQuotes] = useState<Record<string, QuoteTick>>({});
  const [watchlist] = useState<string[]>([...DEFAULT_WATCHLIST_IDS]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchSeed, setSearchSeed] = useState('');
  const [vaultOpen, setVaultOpen] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);

  // Restore last workspace from IndexedDB on boot
  useEffect(() => {
    void loadWorkspaceLocal('default').then((ws) => {
      if (!ws) return;
      setTheme(ws.theme);
      const t0 = ws.tiles[0];
      if (t0) {
        const found = findSymbolById(t0.symbol);
        if (found) setSymbol(found);
        setResolution(t0.resolution);
        setChartStyle(t0.chartStyle);
        setScaleMode(t0.priceScaleMode);
        setInverted(t0.inverted);
      }
    });
  }, []);

  // Debounced IndexedDB + Bridge SQLite workspace auto-save
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const snapshot: WorkspaceSnapshot = {
        id: 'default',
        name: 'Default Workspace',
        revision: 1,
        updatedAt: Date.now(),
        theme,
        layoutGrid: '1x1',
        syncCrosshair: true,
        syncInterval: false,
        syncTime: false,
        tiles: [
          {
            id: 'tile-1',
            symbol: symbol.id,
            resolution,
            chartStyle,
            priceScaleMode: scaleMode,
            inverted,
            syncGroup: 'none',
            showVolume: true,
            useFuturesVolumeProxy: false,
          },
        ],
        drawings: [],
      };
      void saveWorkspaceLocal(snapshot);
      void clientRef.current?.syncWorkspaceToBridge(snapshot);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [symbol.id, resolution, chartStyle, scaleMode, inverted, theme]);

  // Boot MarketClient + mount clean-room Canvas 2D controller
  useEffect(() => {
    const client = new MarketClient();
    clientRef.current = client;
    const unsubState = client.onConnectionChange(setBridge);

    const el = containerRef.current;
    let ctrl: ChartController | null = null;
    if (el) {
      ctrl = new ChartController({
        symbol,
        resolution,
        chartStyle,
        priceScaleMode: scaleMode,
        theme,
      });
      ctrl.mount(el);
      controllerRef.current = ctrl;
      ctrl.onLoadMoreHistory((beforeTime) => {
        client.requestMoreHistory('tile-1', beforeTime, 400);
      });
    }

    let unsubQuotes: (() => void) | null = null;
    void client.connect().then(() => {
      unsubQuotes = client.subscribeQuotes(watchlist, (q) => {
        quoteBufferRef.current[q.symbol] = q;
      });
    });

    // rAF/interval-throttled UI snapshots (<= 4 Hz for React Watchlist & Telemetry — zero hot-path jitter!)
    const uiTimer = window.setInterval(() => {
      if (ctrl) setTelemetry(ctrl.getTelemetry());
      const buffered = quoteBufferRef.current;
      if (Object.keys(buffered).length > 0) {
        setQuotes((prev) => ({ ...prev, ...buffered }));
        quoteBufferRef.current = {};
      }
    }, 250);

    return () => {
      window.clearInterval(uiTimer);
      unsubQuotes?.();
      unsubState();
      client.dispose();
      ctrl?.destroy();
      controllerRef.current = null;
      clientRef.current = null;
    };
    // Mount once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyRsiToBars = (ctrl: ChartController, bars: readonly OHLCVBar[]) => {
    if (!showRsiPane) {
      ctrl.removeSubPane('rsi14');
      return;
    }
    ctrl.addSubPane('rsi14', 0.23, 2);
    const closes = new Float64Array(bars.length);
    for (let i = 0; i < bars.length; i++) closes[i] = bars[i]!.close;
    void loadBrowserWasm()
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
  };

  // Subscribe chart to live Bridge / Direct datafeed whenever symbol, resolution, or bridge state changes
  useEffect(() => {
    const ctrl = controllerRef.current;
    const client = clientRef.current;
    if (!ctrl || !client || bridge.mode === 'connecting') return;

    if (stress250k) {
      const bars = generateSyntheticBars(symbol, resolution, 250_000, 99);
      ctrl.setSymbolInfo(symbol, resolution);
      ctrl.setBars(bars, 250_000);
      setProviderLabel('250k Mipmap Benchmark');
      applyRsiToBars(ctrl, bars);
      return;
    }

    const activeBarsRef: OHLCVBar[] = [];
    const unsub = client.subscribeChart('tile-1', symbol.id, resolution, {
      onSnapshot: (resolvedInfo, bars, _noMore, label) => {
        activeBarsRef.length = 0;
        activeBarsRef.push(...bars);
        setSymbol(resolvedInfo);
        setProviderLabel(label);
        ctrl.setSymbolInfo(resolvedInfo, resolution);
        ctrl.setBars(bars, 140);
        applyRsiToBars(ctrl, bars);
      },
      onBarUpdate: (bar, quality) => {
        ctrl.upsertBar(bar);
        setSymbol((prev) => (prev.feedQuality === quality ? prev : { ...prev, feedQuality: quality }));
      },
      onHistoryResult: (olderBars) => {
        if (olderBars.length > 0) {
          ctrl.prependBars(olderBars);
        }
      },
    });

    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol.id, resolution, bridge.mode, stress250k, showRsiPane, reloadNonce]);

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

  // TradingView-parity keyboard shortcuts (Ctrl+K, start typing letters -> Symbol Search, Alt+L/I/R)
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const target = ev.target as HTMLElement | null;
      const inInput =
        target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.tagName === 'SELECT';

      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') {
        ev.preventDefault();
        setSearchSeed('');
        setSearchOpen(true);
        return;
      }
      if (inInput || searchOpen || vaultOpen) return;

      if (ev.altKey && ev.key.toLowerCase() === 'l') {
        ev.preventDefault();
        setScaleMode((m) => (m === 'symlog' ? 'linear' : 'symlog'));
      } else if (ev.altKey && ev.key.toLowerCase() === 'i') {
        ev.preventDefault();
        setInverted((v) => !v);
      } else if (ev.altKey && ev.key.toLowerCase() === 'r') {
        ev.preventDefault();
        controllerRef.current?.resetView();
      } else if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && /^[a-zA-Z]$/.test(ev.key)) {
        setSearchSeed(ev.key.toUpperCase());
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [searchOpen, vaultOpen]);

  const handleLocalFile = async (ev: React.ChangeEvent<HTMLInputElement>) => {
    const file = ev.target.files?.[0];
    if (!file || !controllerRef.current) return;
    try {
      const bars = file.name.toLowerCase().endsWith('.parquet')
        ? await parseParquetBars(await file.arrayBuffer())
        : parseCsvBars(await file.text());
      if (bars.length > 0) {
        const localSym: SymbolInfo = {
          ...symbol,
          id: `LOCAL:${file.name}`,
          ticker: file.name.replace(/\.(csv|parquet)$/i, '').toUpperCase(),
          exchange: 'LOCAL FILE',
          provider: 'local_file',
          feedQuality: 'delayed_eod',
          hasVolume: bars.some((b) => b.volume > 0),
        };
        setSymbol(localSym);
        setProviderLabel(`${file.name} (${bars.length.toLocaleString()} bars)`);
        controllerRef.current.setSymbolInfo(localSym, resolution);
        controllerRef.current.setBars(bars, 160);
        applyRsiToBars(controllerRef.current, bars);
      }
    } catch {
      setProviderLabel('Failed to parse CSV/Parquet file');
    }
    ev.target.value = '';
  };

  const handleSnapshot = () => {
    const url = controllerRef.current?.exportSnapshotDataUrl();
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = `openview-${symbol.ticker}-${resolution}.png`;
    a.click();
  };

  const isDark = theme === 'dark';
  const badge = badgeMeta(symbol.feedQuality);

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

          {/* Symbol Search Trigger */}
          <button
            onClick={() => {
              setSearchSeed('');
              setSearchOpen(true);
            }}
            className={`flex items-center gap-2 rounded border px-2.5 py-1 font-mono text-xs font-semibold transition ${
              isDark
                ? 'border-[#2a2e39] bg-[#1e222d] text-white hover:border-[#2962ff]'
                : 'border-[#d1d4dc] bg-[#f0f3fa] text-[#131722] hover:border-[#2962ff]'
            }`}
            title="Search symbols (Ctrl+K or start typing)"
          >
            <span>{symbol.ticker}</span>
            <span className="text-[10px] font-normal text-[#787b86]">{symbol.exchange}</span>
          </button>

          {/* Honest Feed & Volume Integrity Badge */}
          <span
            className={`hidden rounded px-1.5 py-0.5 font-mono text-[10px] font-medium xl:inline ${badge.cls}`}
            title={`Active data source: ${providerLabel}`}
          >
            ● {badge.label}
          </span>

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
            RSI(14)
          </button>

          <button
            onClick={() => fileInputRef.current?.click()}
            className="rounded px-2 py-1 text-[11px] text-[#868993] hover:bg-[#1e222d] hover:text-white"
            title="Load local CSV or Parquet OHLCV file (hyparquet)"
          >
            CSV/Parquet
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.parquet"
            className="hidden"
            onChange={handleLocalFile}
          />

          <button
            onClick={() => setStress250k((v) => !v)}
            className={`rounded px-2 py-1 font-mono text-[11px] ${
              stress250k ? 'bg-[#089981]/25 text-[#089981]' : 'text-[#787b86] hover:bg-[#1e222d]'
            }`}
          >
            {stress250k ? '250k ON' : '250k'}
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-2 font-mono text-[11px]">
          {telemetry && (
            <span className="hidden text-[#787b86] 2xl:inline">
              {telemetry.medianFrameMs}ms · {telemetry.drawnBars}/{telemetry.totalBars.toLocaleString()} (x
              {telemetry.mipmapStride})
            </span>
          )}
          <button
            onClick={() => setVaultOpen(true)}
            className="rounded border border-[#2962ff]/50 bg-[#2962ff]/15 px-2 py-1 text-[11px] font-medium text-[#6aa0ff] hover:bg-[#2962ff]/25"
          >
            Providers / Keys
          </button>
          <button
            onClick={handleSnapshot}
            className="rounded border border-[#2a2e39] px-2 py-1 text-[11px] hover:bg-[#1e222d]"
          >
            PNG
          </button>
          <button
            onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
            className="rounded border border-[#2a2e39] px-2 py-1 text-[11px] hover:bg-[#1e222d]"
          >
            {isDark ? 'Light' : 'Dark'}
          </button>
          <button
            onClick={() => setShowWatchlist((v) => !v)}
            className={`rounded border border-[#2a2e39] px-2 py-1 text-[11px] ${
              showWatchlist ? 'bg-[#1e222d] text-white' : 'text-[#787b86]'
            }`}
          >
            WL
          </button>
          <span
            className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${
              bridge.mode === 'local_bridge'
                ? 'bg-[#089981]/15 text-[#089981]'
                : 'bg-[#f7931a]/15 text-[#f7931a]'
            }`}
            title={
              bridge.mode === 'local_bridge'
                ? `Secured Local Bridge (${bridge.vaultMode})`
                : 'Bridge Offline — Static Mode (Public Crypto WS + Local Files)'
            }
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

      {/* Main Chart Tile + Right Multi-Market Watchlist */}
      <div className="flex flex-1 overflow-hidden">
        <main className="relative flex-1 overflow-hidden">
          <div ref={containerRef} className="h-full w-full" />
        </main>
        {showWatchlist && (
          <WatchlistPanel
            symbolIds={watchlist}
            activeSymbolId={symbol.id}
            quotes={quotes}
            isDark={isDark}
            onSelect={(sym) => {
              setStress250k(false);
              setSymbol(sym);
            }}
            onOpenSearch={() => {
              setSearchSeed('');
              setSearchOpen(true);
            }}
          />
        )}
      </div>

      <SymbolSearchModal
        open={searchOpen}
        initialQuery={searchSeed}
        onClose={() => setSearchOpen(false)}
        onSelect={(sym) => {
          setStress250k(false);
          setSymbol(sym);
        }}
      />

      {clientRef.current && (
        <ProviderVaultModal
          open={vaultOpen}
          client={clientRef.current}
          bridgeOnline={bridge.mode === 'local_bridge'}
          {...(bridge.vaultMode ? { vaultMode: bridge.vaultMode } : {})}
          onClose={() => setVaultOpen(false)}
          onUpdated={() => setReloadNonce((n) => n + 1)}
        />
      )}
    </div>
  );
}
