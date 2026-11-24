import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { PaperBrokerEngine, type PaperAccountSnapshot } from '@openview/broker-sdk';
import type { ChartController, FrameTelemetry } from '@openview/chart-engine';
import {
  isSyntheticPriceChart,
  type NonTimeChartMode,
  type SpreadAlignmentMode,
} from '@openview/chart-types';
import {
  DEFAULT_WATCHLIST_IDS,
  findSymbolById,
  parseCsvBars,
  parseParquetBars,
} from '@openview/datafeed-sdk';
import {
  DrawingManager,
  type DrawingToolType,
  type MagnetMode,
} from '@openview/drawings';
import type {
  ChartStyle,
  ChartTileState,
  FeedQualityBadge,
  OHLCVBar,
  PriceScaleMode,
  QuoteTick,
  Resolution,
  SymbolInfo,
  WorkspaceSnapshot,
} from '@openview/protocol';
import { MasterReplayClock, type ReplaySnapshot } from '@openview/replay-engine';
import { PINE_TEMPLATES } from '@openview/script-runtime';
import { IndicatorPickerModal } from './modals/IndicatorPickerModal.tsx';
import { ProviderVaultModal } from './modals/ProviderVaultModal.tsx';
import { SymbolSearchModal } from './modals/SymbolSearchModal.tsx';
import { AlertsPanel } from './panels/AlertsPanel.tsx';
import { DomLadderPanel } from './panels/DomLadderPanel.tsx';
import { ObjectTreePanel } from './panels/ObjectTreePanel.tsx';
import { OrderTicketPanel } from './panels/OrderTicketPanel.tsx';
import { WatchlistPanel } from './panels/WatchlistPanel.tsx';
import {
  MarketClient,
  type AlertTriggerEventClient,
  type BridgeConnectionState,
} from './services/market-client.ts';
import { loadWorkspaceLocal, saveWorkspaceLocal } from './storage/workspace-store.ts';
import { ChartTile } from './workbench/ChartTile.tsx';
import { LeftDrawingToolbar } from './workbench/LeftDrawingToolbar.tsx';
import { ReplayBar } from './workbench/ReplayBar.tsx';
import { WorkspaceSyncBus } from './workbench/sync-bus.ts';

// Lazy-loaded heavy drawers keep initial gzipped JS strictly < 200 KB!
const ScriptDrawer = lazy(() => import('./lazy/ScriptDrawer.tsx'));
const StrategyTesterDrawer = lazy(() => import('./lazy/StrategyTesterDrawer.tsx'));
const OptionChainDrawer = lazy(() => import('./lazy/OptionChainDrawer.tsx'));
const ScreenerDrawer = lazy(() => import('./lazy/ScreenerDrawer.tsx'));

type LayoutGrid = WorkspaceSnapshot['layoutGrid'];

const RESOLUTIONS: Resolution[] = ['1', '5', '15', '60', '240', '1D'];
const LAYOUTS: Array<{ id: LayoutGrid; label: string; count: number; gridClass: string }> = [
  { id: '1x1', label: '1', count: 1, gridClass: 'grid-cols-1 grid-rows-1' },
  { id: '1x2', label: '2V', count: 2, gridClass: 'grid-cols-2 grid-rows-1' },
  { id: '2x1', label: '2H', count: 2, gridClass: 'grid-cols-1 grid-rows-2' },
  { id: '2x2', label: '4', count: 4, gridClass: 'grid-cols-2 grid-rows-2' },
  { id: '3x2', label: '6', count: 6, gridClass: 'grid-cols-3 grid-rows-2' },
  { id: '4x2', label: '8', count: 8, gridClass: 'grid-cols-4 grid-rows-2' },
];
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

const DEFAULT_MULTI_SYMBOLS = [
  'BINANCE:BTCUSDT',
  'FX:XAUUSD',
  'US:NVDA',
  'NSE:RELIANCE',
  'BINANCE:ETHUSDT',
  'FX:EURUSD',
  'NSE:NIFTY',
  'NSE:BANKNIFTY',
];

function createTile(index: number): ChartTileState {
  return {
    id: `tile-${index + 1}`,
    symbol: DEFAULT_MULTI_SYMBOLS[index % DEFAULT_MULTI_SYMBOLS.length]!,
    resolution: index === 0 ? '15' : index === 1 ? '60' : '15',
    chartStyle: 'candles',
    priceScaleMode: 'linear',
    inverted: false,
    syncGroup: 'none',
    showVolume: true,
    useFuturesVolumeProxy: false,
  };
}

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
    default:
      return { label: 'DELAYED / EOD', cls: 'bg-[#f7931a]/15 text-[#f7931a]' };
  }
}

export function App() {
  const clientRef = useRef<MarketClient | null>(null);
  const syncBusRef = useRef<WorkspaceSyncBus>(new WorkspaceSyncBus());
  const drawingManagerRef = useRef<DrawingManager>(new DrawingManager());
  const replayClockRef = useRef<MasterReplayClock>(new MasterReplayClock());
  const paperBrokerRef = useRef<PaperBrokerEngine>(new PaperBrokerEngine(100_000, 1));
  const activeControllerRef = useRef<ChartController | null>(null);
  const activeBarsRef = useRef<OHLCVBar[]>([]);
  const [, setActiveBarsCount] = useState(0);
  const [latestActiveBar, setLatestActiveBar] = useState<OHLCVBar | null>(null);
  const [paperAccount, setPaperAccount] = useState<PaperAccountSnapshot>(() =>
    paperBrokerRef.current.getSnapshot(),
  );
  const [bottomDrawer, setBottomDrawer] = useState<'none' | 'script' | 'backtest' | 'options' | 'screener'>('none');
  const [liveAlertEvents, setLiveAlertEvents] = useState<AlertTriggerEventClient[]>([]);
  const [alertToast, setAlertToast] = useState<AlertTriggerEventClient | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const quoteBufferRef = useRef<Record<string, QuoteTick>>({});

  if (!clientRef.current) {
    clientRef.current = new MarketClient();
  }

  const [bridge, setBridge] = useState<BridgeConnectionState>({ mode: 'connecting' });
  const [layoutGrid, setLayoutGrid] = useState<LayoutGrid>('1x1');
  const [tiles, setTiles] = useState<ChartTileState[]>(() => [createTile(0)]);
  const [activeTileId, setActiveTileId] = useState<string>('tile-1');
  const [maximizedTileId, setMaximizedTileId] = useState<string | null>(null);
  const [syncCrosshair, setSyncCrosshair] = useState(true);
  const [syncInterval, setSyncInterval] = useState(false);

  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [activeIndicatorIds, setActiveIndicatorIds] = useState<string[]>(['ema20', 'rsi14']);
  const [indicatorModalOpen, setIndicatorModalOpen] = useState(false);

  // Lazy Script Drawer state (defaults to Pine v6 Dual EMA)
  const [scriptDraftCode, setScriptDraftCode] = useState(PINE_TEMPLATES.pine_ema_cross!.code);
  const [activeScriptCode, setActiveScriptCode] = useState<string | null>(null);
  const [scriptRunNonce, setScriptRunNonce] = useState(0);
  const [scriptLogs, setScriptLogs] = useState<string[]>([]);
  const [scriptError, setScriptError] = useState<string | undefined>(undefined);
  const [scriptElapsedMs, setScriptElapsedMs] = useState<number | undefined>(undefined);

  // Replay state
  const [replaySnap, setReplaySnap] = useState<ReplaySnapshot>(() => replayClockRef.current.getSnapshot());
  const [replayTickNonce, setReplayTickNonce] = useState(0);

  const [rightTab, setRightTab] = useState<'watchlist' | 'objects' | 'trade' | 'dom' | 'alerts' | 'none'>('watchlist');
  const [chartMode, setChartMode] = useState<NonTimeChartMode>('standard');
  const [showVrvp, setShowVrvp] = useState(false);
  const [showFootprint, setShowFootprint] = useState(false);
  const [showTpo, setShowTpo] = useState(false);
  const [spreadAlignment, setSpreadAlignment] = useState<SpreadAlignmentMode>('ffill');
  const [stress250k, setStress250k] = useState(false);
  const [activeMeta, setActiveMeta] = useState<{ info: SymbolInfo; label: string }>({
    info: findSymbolById('BINANCE:BTCUSDT')!,
    label: 'Connecting...',
  });
  const [telemetry, setTelemetry] = useState<FrameTelemetry | null>(null);
  const [quotes, setQuotes] = useState<Record<string, QuoteTick>>({});
  const [watchlist] = useState<string[]>([...DEFAULT_WATCHLIST_IDS]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchSeed, setSearchSeed] = useState('');
  const [vaultOpen, setVaultOpen] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [localFileOverride, setLocalFileOverride] = useState<{
    symbol: SymbolInfo;
    bars: OHLCVBar[];
    label: string;
  } | null>(null);

  const [activeTool, setActiveTool] = useState<DrawingToolType | null>(null);
  const [magnetMode, setMagnetMode] = useState<MagnetMode>('off');
  const [stayInMode, setStayInMode] = useState(false);
  const [hideAllDrawings, setHideAllDrawings] = useState(false);
  const [drawRev, setDrawRev] = useState(0);

  const activeTile = tiles.find((t) => t.id === activeTileId) ?? tiles[0]!;
  const layoutSpec = LAYOUTS.find((l) => l.id === layoutGrid) ?? LAYOUTS[0]!;

  useEffect(() => {
    return paperBrokerRef.current.onChange(setPaperAccount);
  }, []);

  useEffect(() => {
    return replayClockRef.current.onChange((snap, latestBaseBar) => {
      setReplaySnap(snap);
      setReplayTickNonce((n) => n + 1);
      if (snap.active && latestBaseBar) {
        setLatestActiveBar(latestBaseBar);
        paperBrokerRef.current.onBarUpdate(activeMeta.info.id, latestBaseBar);
      }
    });
  }, [activeMeta.info.id]);

  useEffect(() => {
    const dm = drawingManagerRef.current;
    return dm.onChange(() => {
      setActiveTool(dm.activeTool);
      setDrawRev((r) => r + 1);
    });
  }, []);

  useEffect(() => {
    void loadWorkspaceLocal('default').then((ws) => {
      if (!ws) return;
      setTheme(ws.theme);
      setLayoutGrid(ws.layoutGrid);
      setSyncCrosshair(ws.syncCrosshair);
      setSyncInterval(ws.syncInterval);
      if (ws.tiles.length > 0) {
        setTiles(ws.tiles);
        setActiveTileId(ws.tiles[0]!.id);
      }
      if (ws.drawings.length > 0) {
        drawingManagerRef.current.loadDrawings(ws.drawings);
      }
    });
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const snapshot: WorkspaceSnapshot = {
        id: 'default',
        name: 'Default Workspace',
        revision: 1,
        updatedAt: Date.now(),
        theme,
        layoutGrid,
        syncCrosshair,
        syncInterval,
        syncTime: false,
        tiles,
        drawings: drawingManagerRef.current.getAllDrawings(),
      };
      void saveWorkspaceLocal(snapshot);
      void clientRef.current?.syncWorkspaceToBridge(snapshot);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [tiles, layoutGrid, syncCrosshair, syncInterval, theme, drawRev]);

  useEffect(() => {
    const client = clientRef.current!;
    const unsubState = client.onConnectionChange(setBridge);
    const unsubAlerts = client.onAlertTriggered((ev) => {
      setLiveAlertEvents((prev) => [ev, ...prev].slice(0, 50));
      setAlertToast(ev);
      window.setTimeout(() => setAlertToast((cur) => (cur?.id === ev.id ? null : cur)), 5000);
    });

    let unsubQuotes: (() => void) | null = null;
    void client.connect().then(() => {
      unsubQuotes = client.subscribeQuotes(watchlist, (q) => {
        quoteBufferRef.current[q.symbol] = q;
      });
    });

    const uiTimer = window.setInterval(() => {
      const buffered = quoteBufferRef.current;
      if (Object.keys(buffered).length > 0) {
        setQuotes((prev) => ({ ...prev, ...buffered }));
        quoteBufferRef.current = {};
      }
    }, 250);

    return () => {
      window.clearInterval(uiTimer);
      unsubQuotes?.();
      unsubAlerts();
      unsubState();
      client.dispose();
    };
  }, [watchlist]);

  const updateActiveTile = (patch: Partial<ChartTileState>, applyToAll = false) => {
    setTiles((prev) =>
      prev.map((t) => (applyToAll || t.id === activeTile.id ? { ...t, ...patch } : t)),
    );
  };

  const handleLayoutChange = (nextLayout: LayoutGrid) => {
    const spec = LAYOUTS.find((l) => l.id === nextLayout) ?? LAYOUTS[0]!;
    setLayoutGrid(nextLayout);
    setMaximizedTileId(null);
    setTiles((prev) => {
      const next = [...prev];
      while (next.length < spec.count) next.push(createTile(next.length));
      return next.slice(0, spec.count);
    });
  };

  const selectTool = (tool: DrawingToolType | null) => {
    drawingManagerRef.current.activeTool = tool;
    setActiveTool(tool);
  };

  const toggleReplay = () => {
    if (replaySnap.active) {
      replayClockRef.current.stop();
      return;
    }
    if (activeBarsRef.current.length > 20) {
      replayClockRef.current.start(activeBarsRef.current, Math.floor(activeBarsRef.current.length * 0.65));
    }
  };

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
      if (inInput || searchOpen || vaultOpen || indicatorModalOpen) return;

      if (ev.key === 'Escape') {
        selectTool(null);
        return;
      }
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') {
        ev.preventDefault();
        drawingManagerRef.current.undo();
        return;
      }
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'y') {
        ev.preventDefault();
        drawingManagerRef.current.redo();
        return;
      }
      if (ev.key === 'Delete' || ev.key === 'Backspace') {
        const sel = drawingManagerRef.current.selectedId;
        if (sel) {
          ev.preventDefault();
          drawingManagerRef.current.deleteDrawing(sel);
        }
        return;
      }
      if (ev.altKey && ev.key === 'Enter') {
        ev.preventDefault();
        setMaximizedTileId((m) => (m ? null : activeTile.id));
        return;
      }
      if (ev.altKey) {
        const k = ev.key.toLowerCase();
        if (k === 't') { ev.preventDefault(); selectTool('trendline'); }
        else if (k === 'h') { ev.preventDefault(); selectTool('horizontal_line'); }
        else if (k === 'j') { ev.preventDefault(); selectTool('horizontal_ray'); }
        else if (k === 'v') { ev.preventDefault(); selectTool('vertical_line'); }
        else if (k === 'f') { ev.preventDefault(); selectTool('fib_retracement'); }
        else if (k === 'l') {
          ev.preventDefault();
          updateActiveTile({ priceScaleMode: activeTile.priceScaleMode === 'symlog' ? 'linear' : 'symlog' });
        } else if (k === 'i') {
          ev.preventDefault();
          updateActiveTile({ inverted: !activeTile.inverted });
        } else if (k === 'r') {
          ev.preventDefault();
          activeControllerRef.current?.resetView();
        }
        return;
      }
      if (!ev.ctrlKey && !ev.metaKey && /^[a-zA-Z]$/.test(ev.key)) {
        setSearchSeed(ev.key.toUpperCase());
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchOpen, vaultOpen, indicatorModalOpen, activeTile]);

  const handleLocalFile = async (ev: React.ChangeEvent<HTMLInputElement>) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    try {
      const bars = file.name.toLowerCase().endsWith('.parquet')
        ? await parseParquetBars(await file.arrayBuffer())
        : parseCsvBars(await file.text());
      if (bars.length > 0) {
        const localSym: SymbolInfo = {
          ...activeMeta.info,
          id: `LOCAL:${file.name}`,
          ticker: file.name.replace(/\.(csv|parquet)$/i, '').toUpperCase(),
          exchange: 'LOCAL FILE',
          provider: 'local_file',
          feedQuality: 'delayed_eod',
          hasVolume: bars.some((b) => b.volume > 0),
        };
        setLocalFileOverride({
          symbol: localSym,
          bars,
          label: `${file.name} (${bars.length.toLocaleString()} bars)`,
        });
      }
    } catch {
      // ignore invalid file
    }
    ev.target.value = '';
  };

  const handleSnapshot = () => {
    const url = activeControllerRef.current?.exportSnapshotDataUrl();
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = `openview-${activeMeta.info.ticker}-${activeTile.resolution}.png`;
    a.click();
  };

  const isDark = theme === 'dark';
  const badge = badgeMeta(activeMeta.info.feedQuality);
  const visibleTiles = maximizedTileId
    ? tiles.filter((t) => t.id === maximizedTileId)
    : tiles;

  return (
    <div
      className={`flex h-full w-full flex-col ${
        isDark ? 'bg-[#0b0e14] text-[#d1d4dc]' : 'bg-[#f8f9fd] text-[#131722]'
      }`}
    >
      {/* Top Toolbar */}
      <header
        className={`flex h-11 shrink-0 items-center justify-between gap-2 border-b px-3 text-xs ${
          isDark ? 'border-[#2a2e39] bg-[#131722]' : 'border-[#e0e3eb] bg-white'
        }`}
      >
        <div className="flex items-center gap-2 overflow-x-auto">
          <span className="font-bold tracking-tight text-[#2962ff]">OpenView</span>

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
          >
            <span>{activeMeta.info.ticker}</span>
            <span className="text-[10px] font-normal text-[#787b86]">{activeMeta.info.exchange}</span>
          </button>

          <span
            className={`hidden rounded px-1.5 py-0.5 font-mono text-[10px] font-medium 2xl:inline ${badge.cls}`}
            title={`Active data source: ${activeMeta.label}`}
          >
            ● {badge.label}
          </span>

          <div className="h-4 w-px bg-[#2a2e39]" />

          <div className="flex items-center gap-0.5">
            {RESOLUTIONS.map((r) => (
              <button
                key={r}
                onClick={() => updateActiveTile({ resolution: r }, syncInterval)}
                className={`rounded px-1.5 py-1 font-mono text-[11px] transition ${
                  activeTile.resolution === r
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

          <select
            value={activeTile.chartStyle}
            onChange={(e) => updateActiveTile({ chartStyle: e.target.value as ChartStyle })}
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

          <select
            value={chartMode}
            onChange={(e) => setChartMode(e.target.value as NonTimeChartMode)}
            title="Non-Time Chart Mode (1m-sourced Renko, Range, Kagi, P&F, 3-Line Break)"
            className={`rounded border px-1.5 py-1 font-mono text-[11px] outline-none ${
              chartMode !== 'standard'
                ? 'border-[#f7931a]/60 bg-[#f7931a]/15 text-[#f7931a]'
                : isDark
                  ? 'border-[#2a2e39] bg-[#1e222d] text-[#d1d4dc]'
                  : 'border-[#d1d4dc] bg-[#f0f3fa] text-[#131722]'
            }`}
          >
            <option value="standard">Time Bars</option>
            <option value="renko">Renko (ATR)</option>
            <option value="range">Range Bars</option>
            <option value="kagi">Kagi</option>
            <option value="point_and_figure">Point &amp; Figure</option>
            <option value="line_break">3-Line Break</option>
          </select>

          <button
            onClick={() => setShowVrvp((v) => !v)}
            className={`rounded px-1.5 py-1 font-mono text-[10.5px] ${
              showVrvp ? 'bg-[#2962ff]/25 text-[#6aa0ff]' : 'text-[#787b86] hover:bg-[#1e222d]'
            }`}
            title="Visible Range Volume Profile (VRVP + POC/VAH/VAL)"
          >
            VP
          </button>
          <button
            onClick={() => setShowFootprint((v) => !v)}
            className={`rounded px-1.5 py-1 font-mono text-[10.5px] ${
              showFootprint ? 'bg-[#f7931a]/25 text-[#f7931a]' : 'text-[#787b86] hover:bg-[#1e222d]'
            }`}
            title="Orderflow Footprint Cluster Overlay"
          >
            FP
          </button>
          <button
            onClick={() => setShowTpo((v) => !v)}
            className={`rounded px-1.5 py-1 font-mono text-[10.5px] ${
              showTpo ? 'bg-[#ab47bc]/25 text-[#ce93d8]' : 'text-[#787b86] hover:bg-[#1e222d]'
            }`}
            title="TPO Market Profile (Letters + Initial Balance)"
          >
            TPO
          </button>

          <div className="flex items-center gap-0.5">
            {SCALE_MODES.map((m) => (
              <button
                key={m.id}
                onClick={() => updateActiveTile({ priceScaleMode: m.id })}
                className={`rounded px-1.5 py-1 font-mono text-[11px] ${
                  activeTile.priceScaleMode === m.id
                    ? 'bg-[#2962ff]/25 text-[#5b9cf6]'
                    : 'text-[#787b86] hover:bg-[#1e222d]'
                }`}
              >
                {m.label}
              </button>
            ))}
            <button
              onClick={() => updateActiveTile({ inverted: !activeTile.inverted })}
              className={`rounded px-1.5 py-1 font-mono text-[11px] ${
                activeTile.inverted ? 'bg-[#f23645]/25 text-[#f23645]' : 'text-[#787b86] hover:bg-[#1e222d]'
              }`}
            >
              Inv
            </button>
          </div>

          <div className="h-4 w-px bg-[#2a2e39]" />

          <button
            onClick={() => setIndicatorModalOpen(true)}
            className="rounded bg-[#7e57c2]/20 px-2 py-1 text-[11px] font-medium text-[#b39ddb] hover:bg-[#7e57c2]/30"
          >
            ƒx Indicators ({activeIndicatorIds.length})
          </button>

          <button
            onClick={toggleReplay}
            className={`rounded px-2 py-1 text-[11px] font-medium ${
              replaySnap.active
                ? 'bg-[#f7931a]/25 text-[#f7931a]'
                : 'text-[#868993] hover:bg-[#1e222d] hover:text-white'
            }`}
          >
            ⏪ Replay
          </button>

          <button
            onClick={() => setBottomDrawer((d) => (d === 'script' ? 'none' : 'script'))}
            className={`rounded px-2 py-1 text-[11px] font-medium ${
              bottomDrawer === 'script'
                ? 'bg-[#2962ff]/25 text-[#6aa0ff]'
                : 'text-[#868993] hover:bg-[#1e222d] hover:text-white'
            }`}
          >
            {'</>'} Script
          </button>

          <button
            onClick={() => setBottomDrawer((d) => (d === 'backtest' ? 'none' : 'backtest'))}
            className={`rounded px-2 py-1 text-[11px] font-medium ${
              bottomDrawer === 'backtest'
                ? 'bg-[#089981]/25 text-[#089981]'
                : 'text-[#868993] hover:bg-[#1e222d] hover:text-white'
            }`}
          >
            Backtest
          </button>

          <button
            onClick={() => setBottomDrawer((d) => (d === 'options' ? 'none' : 'options'))}
            className={`rounded px-2 py-1 text-[11px] font-medium ${
              bottomDrawer === 'options'
                ? 'bg-[#ab47bc]/25 text-[#ce93d8]'
                : 'text-[#868993] hover:bg-[#1e222d] hover:text-white'
            }`}
          >
            Options
          </button>

          <button
            onClick={() => setBottomDrawer((d) => (d === 'screener' ? 'none' : 'screener'))}
            className={`rounded px-2 py-1 text-[11px] font-medium ${
              bottomDrawer === 'screener'
                ? 'bg-[#26c6da]/25 text-[#4dd0e1]'
                : 'text-[#868993] hover:bg-[#1e222d] hover:text-white'
            }`}
          >
            Screener
          </button>

          <div className="h-4 w-px bg-[#2a2e39]" />

          <div className="flex items-center gap-0.5">
            {LAYOUTS.map((l) => (
              <button
                key={l.id}
                onClick={() => handleLayoutChange(l.id)}
                className={`rounded px-1.5 py-1 font-mono text-[10.5px] ${
                  layoutGrid === l.id
                    ? 'bg-[#2962ff] text-white'
                    : 'text-[#787b86] hover:bg-[#1e222d] hover:text-white'
                }`}
              >
                {l.label}
              </button>
            ))}
          </div>

          <button
            onClick={() => setSyncCrosshair((v) => !v)}
            className={`rounded px-1.5 py-1 font-mono text-[10.5px] ${
              syncCrosshair ? 'bg-[#089981]/20 text-[#089981]' : 'text-[#787b86]'
            }`}
            title="Sync Crosshair"
          >
            Sync┼
          </button>

          <button
            onClick={() => setSyncInterval((v) => !v)}
            className={`rounded px-1.5 py-1 font-mono text-[10.5px] ${
              syncInterval ? 'bg-[#089981]/20 text-[#089981]' : 'text-[#787b86]'
            }`}
            title="Sync Interval"
          >
            SyncTF
          </button>

          <button
            onClick={() => fileInputRef.current?.click()}
            className="rounded px-1.5 py-1 text-[11px] text-[#868993] hover:bg-[#1e222d] hover:text-white"
          >
            CSV
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
            className={`rounded px-1.5 py-1 font-mono text-[10.5px] ${
              stress250k ? 'bg-[#089981]/25 text-[#089981]' : 'text-[#787b86] hover:bg-[#1e222d]'
            }`}
          >
            250k
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-1.5 font-mono text-[11px]">
          {telemetry && (
            <span className="hidden text-[#787b86] 2xl:inline">
              {telemetry.medianFrameMs}ms · {telemetry.drawnBars}/{telemetry.totalBars.toLocaleString()}
            </span>
          )}
          <button
            onClick={() => setVaultOpen(true)}
            className="rounded border border-[#2962ff]/50 bg-[#2962ff]/15 px-2 py-1 text-[11px] font-medium text-[#6aa0ff] hover:bg-[#2962ff]/25"
          >
            Providers
          </button>
          <button
            onClick={handleSnapshot}
            className="rounded border border-[#2a2e39] px-1.5 py-1 text-[10.5px] hover:bg-[#1e222d]"
          >
            PNG
          </button>
          <button
            onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
            className="rounded border border-[#2a2e39] px-1.5 py-1 text-[11px] hover:bg-[#1e222d]"
          >
            {isDark ? '☀' : '☾'}
          </button>
          <button
            onClick={() => setRightTab((t) => (t === 'watchlist' ? 'none' : 'watchlist'))}
            className={`rounded border border-[#2a2e39] px-1.5 py-1 text-[10.5px] ${
              rightTab === 'watchlist' ? 'bg-[#1e222d] text-white' : 'text-[#787b86]'
            }`}
          >
            WL
          </button>
          <button
            onClick={() => setRightTab((t) => (t === 'objects' ? 'none' : 'objects'))}
            className={`rounded border border-[#2a2e39] px-1.5 py-1 text-[10.5px] ${
              rightTab === 'objects' ? 'bg-[#1e222d] text-white' : 'text-[#787b86]'
            }`}
          >
            OBJ
          </button>
          <button
            onClick={() => setRightTab((t) => (t === 'trade' ? 'none' : 'trade'))}
            className={`rounded border border-[#089981]/50 px-1.5 py-1 text-[10.5px] font-semibold ${
              rightTab === 'trade' ? 'bg-[#089981] text-white' : 'text-[#089981]'
            }`}
            title="Paper Trading Order Ticket"
          >
            TRADE
          </button>
          <button
            onClick={() => setRightTab((t) => (t === 'dom' ? 'none' : 'dom'))}
            className={`rounded border border-[#2a2e39] px-1.5 py-1 text-[10.5px] ${
              rightTab === 'dom' ? 'bg-[#2962ff] text-white' : 'text-[#868993]'
            }`}
            title="L2 Depth of Market Ladder"
          >
            DOM
          </button>
          <button
            onClick={() => setRightTab((t) => (t === 'alerts' ? 'none' : 'alerts'))}
            className={`rounded border border-[#2a2e39] px-1.5 py-1 text-[10.5px] ${
              rightTab === 'alerts' ? 'bg-[#f7931a] text-white' : 'text-[#868993]'
            }`}
            title="24/7 Server Alerts & SSRF-Guarded Webhooks"
          >
            🔔
          </button>
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
            {bridge.mode === 'local_bridge' ? `${bridge.wsRttMs}ms` : 'STATIC'}
          </span>
        </div>
      </header>

      {/* Master-Clock Bar Replay Transport */}
      <ReplayBar
        snapshot={replaySnap}
        onPlayPause={() =>
          replaySnap.playing ? replayClockRef.current.pause() : replayClockRef.current.play()
        }
        onStepBack={() => replayClockRef.current.stepBack(1)}
        onStepForward={() => replayClockRef.current.stepForward(1)}
        onSpeedChange={(bps) => replayClockRef.current.setSpeed(bps)}
        onJump={(idx) => replayClockRef.current.jumpToIndex(idx)}
        onExit={() => replayClockRef.current.stop()}
      />

      {/* Main Workbench */}
      <div className="flex flex-1 overflow-hidden">
        <LeftDrawingToolbar
          activeTool={activeTool}
          magnetMode={magnetMode}
          stayInMode={stayInMode}
          hideAll={hideAllDrawings}
          canUndo={drawingManagerRef.current.undoModel.canUndo}
          canRedo={drawingManagerRef.current.undoModel.canRedo}
          isDark={isDark}
          onSelectTool={selectTool}
          onCycleMagnet={() => {
            const next: MagnetMode =
              magnetMode === 'off' ? 'weak' : magnetMode === 'weak' ? 'strong' : 'off';
            drawingManagerRef.current.magnetMode = next;
            setMagnetMode(next);
          }}
          onToggleStayInMode={() => {
            const next = !stayInMode;
            drawingManagerRef.current.stayInDrawingMode = next;
            setStayInMode(next);
          }}
          onToggleHideAll={() => {
            const next = !hideAllDrawings;
            drawingManagerRef.current.hideAll = next;
            setHideAllDrawings(next);
            setDrawRev((r) => r + 1);
            activeControllerRef.current?.requestRedraw(true);
          }}
          onUndo={() => drawingManagerRef.current.undo()}
          onRedo={() => drawingManagerRef.current.redo()}
          onClearDrawings={() => drawingManagerRef.current.clearForSymbol(activeTile.symbol)}
        />

        <div className="flex flex-1 flex-col overflow-hidden">
          <main
            className={`grid flex-1 gap-0.5 overflow-hidden p-0.5 ${
              maximizedTileId ? 'grid-cols-1 grid-rows-1' : layoutSpec.gridClass
            }`}
          >
            {visibleTiles.map((tile) => (
              <ChartTile
                key={tile.id}
                tile={tile}
                isActive={tile.id === activeTile.id}
                isMaximized={maximizedTileId === tile.id}
                bridgeOnlineMode={bridge.mode}
                theme={theme}
                chartMode={chartMode}
                showVrvp={showVrvp}
                showFootprint={showFootprint}
                showTpo={showTpo}
                spreadAlignment={spreadAlignment}
                activeIndicatorIds={activeIndicatorIds}
                customScriptCode={activeScriptCode}
                scriptRunNonce={scriptRunNonce}
                stress250k={stress250k}
                syncCrosshair={syncCrosshair}
                replayActive={replaySnap.active}
                replayClock={replayClockRef.current}
                replayTickNonce={replayTickNonce}
                client={clientRef.current!}
                syncBus={syncBusRef.current}
                drawingManager={drawingManagerRef.current}
                paperAccount={paperAccount}
                reloadNonce={reloadNonce}
                externalBarsOverride={localFileOverride}
                onFocus={() => setActiveTileId(tile.id)}
                onToggleMaximize={() =>
                  setMaximizedTileId((m) => (m === tile.id ? null : tile.id))
                }
                onLiveBarTick={(symId, bar) => {
                  if (tile.id === activeTile.id) setLatestActiveBar(bar);
                  paperBrokerRef.current.onBarUpdate(symId, bar);
                }}
                {...(tile.id === activeTile.id
                  ? {
                      onTelemetry: setTelemetry,
                      onResolvedMeta: (info, label) => setActiveMeta({ info, label }),
                      onBarsLoaded: (bars) => {
                        activeBarsRef.current = bars;
                        setActiveBarsCount(bars.length);
                        setLatestActiveBar(bars[bars.length - 1] ?? null);
                      },
                      onScriptOutput: (logs, ms, err) => {
                        setScriptLogs(logs);
                        setScriptElapsedMs(ms);
                        setScriptError(err);
                      },
                      controllerOutRef: activeControllerRef,
                    }
                  : {})}
              />
            ))}
          </main>

          {bottomDrawer === 'script' && (
            <Suspense fallback={<div className="h-60 border-t border-[#2a2e39] bg-[#131722] p-4 text-xs text-[#787b86]">Loading Script Editor...</div>}>
              <ScriptDrawer
                open
                code={scriptDraftCode}
                logs={scriptLogs}
                {...(scriptError !== undefined ? { error: scriptError } : {})}
                {...(scriptElapsedMs !== undefined ? { elapsedMs: scriptElapsedMs } : {})}
                isDark={isDark}
                onChangeCode={setScriptDraftCode}
                onRun={() => {
                  setActiveScriptCode(scriptDraftCode);
                  setScriptRunNonce((n) => n + 1);
                }}
                onClearScript={() => {
                  setActiveScriptCode(null);
                  setScriptLogs([]);
                  setScriptError(undefined);
                }}
                onClose={() => setBottomDrawer('none')}
              />
            </Suspense>
          )}

          {bottomDrawer === 'backtest' && (
            <Suspense fallback={<div className="h-64 border-t border-[#2a2e39] bg-[#131722] p-4 text-xs text-[#787b86]">Loading Strategy Tester...</div>}>
              <StrategyTesterDrawer
                open
                symbolTicker={activeMeta.info.ticker}
                bars={activeBarsRef.current}
                isSyntheticChart={isSyntheticPriceChart(chartMode, activeTile.chartStyle)}
                chartModeLabel={chartMode !== 'standard' ? chartMode.toUpperCase() : activeTile.chartStyle}
                isDark={isDark}
                onClose={() => setBottomDrawer('none')}
              />
            </Suspense>
          )}

          {bottomDrawer === 'options' && (
            <Suspense fallback={<div className="h-72 border-t border-[#2a2e39] bg-[#131722] p-4 text-xs text-[#787b86]">Loading Option Chain...</div>}>
              <OptionChainDrawer
                open
                symbol={activeMeta.info}
                spotPrice={latestActiveBar?.close ?? 100}
                isDark={isDark}
                onClose={() => setBottomDrawer('none')}
              />
            </Suspense>
          )}

          {bottomDrawer === 'screener' && (
            <Suspense fallback={<div className="h-72 border-t border-[#2a2e39] bg-[#131722] p-4 text-xs text-[#787b86]">Loading Multi-Market Screener...</div>}>
              <ScreenerDrawer
                open
                client={clientRef.current!}
                isDark={isDark}
                onSelectSymbol={(symId) => {
                  setLocalFileOverride(null);
                  setStress250k(false);
                  if (replaySnap.active) replayClockRef.current.stop();
                  updateActiveTile({ symbol: symId });
                }}
                onClose={() => setBottomDrawer('none')}
              />
            </Suspense>
          )}
        </div>

        {rightTab === 'alerts' && (
          <AlertsPanel
            symbol={activeMeta.info}
            latestBar={latestActiveBar}
            client={clientRef.current!}
            bridgeOnline={bridge.mode === 'local_bridge'}
            liveEvents={liveAlertEvents}
            isDark={isDark}
          />
        )}

        {rightTab === 'trade' && (
          <OrderTicketPanel
            symbol={activeMeta.info}
            latestBar={latestActiveBar}
            account={paperAccount}
            broker={paperBrokerRef.current}
            isDark={isDark}
          />
        )}

        {rightTab === 'dom' && (
          <DomLadderPanel
            symbol={activeMeta.info}
            latestBar={latestActiveBar}
            broker={paperBrokerRef.current}
            isDark={isDark}
          />
        )}

        {rightTab === 'watchlist' && (
          <WatchlistPanel
            symbolIds={watchlist}
            activeSymbolId={activeTile.symbol}
            quotes={quotes}
            isDark={isDark}
            onSelect={(sym) => {
              setLocalFileOverride(null);
              setStress250k(false);
              if (replaySnap.active) replayClockRef.current.stop();
              updateActiveTile({ symbol: sym.id });
            }}
            onOpenSearch={() => {
              setSearchSeed('');
              setSearchOpen(true);
            }}
          />
        )}

        {rightTab === 'objects' && (
          <ObjectTreePanel
            symbolId={activeTile.symbol}
            drawingManager={drawingManagerRef.current}
            revision={drawRev}
            isDark={isDark}
          />
        )}
      </div>

      <SymbolSearchModal
        open={searchOpen}
        initialQuery={searchSeed}
        spreadAlignment={spreadAlignment}
        onChangeSpreadAlignment={setSpreadAlignment}
        onClose={() => setSearchOpen(false)}
        onSelect={(sym) => {
          setLocalFileOverride(null);
          setStress250k(false);
          if (replaySnap.active) replayClockRef.current.stop();
          updateActiveTile({ symbol: sym.id });
        }}
      />

      <IndicatorPickerModal
        open={indicatorModalOpen}
        activeIds={activeIndicatorIds}
        hasVolume={activeMeta.info.hasVolume}
        onToggle={(id) =>
          setActiveIndicatorIds((prev) =>
            prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
          )
        }
        onClose={() => setIndicatorModalOpen(false)}
      />

      <ProviderVaultModal
        open={vaultOpen}
        client={clientRef.current!}
        bridgeOnline={bridge.mode === 'local_bridge'}
        {...(bridge.vaultMode ? { vaultMode: bridge.vaultMode } : {})}
        onClose={() => setVaultOpen(false)}
        onUpdated={() => setReloadNonce((n) => n + 1)}
      />

      {alertToast && (
        <div className="fixed right-4 bottom-4 z-50 rounded-md border border-[#f7931a] bg-[#131722] px-4 py-2.5 text-xs shadow-2xl">
          <div className="font-mono font-bold text-[#f7931a]">🔔 {alertToast.alertName}</div>
          <div className="text-[#d1d4dc]">
            {alertToast.symbol} @ {alertToast.price} — {alertToast.message}
          </div>
        </div>
      )}
    </div>
  );
}
