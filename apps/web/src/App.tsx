import { useEffect, useRef, useState } from 'react';
import type { ChartController, FrameTelemetry } from '@openview/chart-engine';
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
import { ProviderVaultModal } from './modals/ProviderVaultModal.tsx';
import { SymbolSearchModal } from './modals/SymbolSearchModal.tsx';
import { ObjectTreePanel } from './panels/ObjectTreePanel.tsx';
import { WatchlistPanel } from './panels/WatchlistPanel.tsx';
import { MarketClient, type BridgeConnectionState } from './services/market-client.ts';
import { loadWorkspaceLocal, saveWorkspaceLocal } from './storage/workspace-store.ts';
import { ChartTile } from './workbench/ChartTile.tsx';
import { LeftDrawingToolbar } from './workbench/LeftDrawingToolbar.tsx';
import { WorkspaceSyncBus } from './workbench/sync-bus.ts';

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
  const activeControllerRef = useRef<ChartController | null>(null);
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
  const [showRsiPane, setShowRsiPane] = useState(true);
  const [rightTab, setRightTab] = useState<'watchlist' | 'objects' | 'none'>('watchlist');
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

  // Drawing toolbar state synchronized with DrawingManager
  const [activeTool, setActiveTool] = useState<DrawingToolType | null>(null);
  const [magnetMode, setMagnetMode] = useState<MagnetMode>('off');
  const [stayInMode, setStayInMode] = useState(false);
  const [hideAllDrawings, setHideAllDrawings] = useState(false);
  const [drawRev, setDrawRev] = useState(0);

  const activeTile = tiles.find((t) => t.id === activeTileId) ?? tiles[0]!;
  const layoutSpec = LAYOUTS.find((l) => l.id === layoutGrid) ?? LAYOUTS[0]!;

  // Sync DrawingManager mutations back to React toolbar/ObjectTree & auto-save
  useEffect(() => {
    const dm = drawingManagerRef.current;
    return dm.onChange(() => {
      setActiveTool(dm.activeTool);
      setDrawRev((r) => r + 1);
    });
  }, []);

  // Restore workspace + drawings from IndexedDB on boot
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

  // Debounced dual persistence (IndexedDB + Bridge SQLite)
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

  // Connect Bridge + live watchlist quotes
  useEffect(() => {
    const client = clientRef.current!;
    const unsubState = client.onConnectionChange(setBridge);

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

  // Global TradingView keyboard shortcuts
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
  }, [searchOpen, vaultOpen, activeTile]);

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
      {/* Top TradingView-Grade Toolbar */}
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
            title="Search symbols (Ctrl+K or start typing)"
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

          {/* Timeframes */}
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

          {/* Chart Style */}
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

          {/* Scale Modes */}
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

          {/* Multi-Chart Layout Grid Switcher (1x1..4x2, strictly <= 16 canvases!) */}
          <div className="flex items-center gap-0.5" title="Multi-Chart Layout Grid">
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
            title="Sync Crosshair across all charts (cross-timeframe)"
          >
            Sync┼
          </button>

          <button
            onClick={() => setSyncInterval((v) => !v)}
            className={`rounded px-1.5 py-1 font-mono text-[10.5px] ${
              syncInterval ? 'bg-[#089981]/20 text-[#089981]' : 'text-[#787b86]'
            }`}
            title="Sync Timeframe changes across all charts"
          >
            SyncTF
          </button>

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
            className={`rounded px-1.5 py-1 font-mono text-[11px] ${
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
            className="rounded border border-[#2a2e39] px-2 py-1 text-[11px] hover:bg-[#1e222d]"
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
            title="Object Tree (Drawings)"
          >
            OBJ
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

      {/* Main Workbench: Left Drawing Bar + Multi-Chart Grid + Right Dockable Sidebar */}
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
              showRsiPane={showRsiPane}
              stress250k={stress250k}
              syncCrosshair={syncCrosshair}
              client={clientRef.current!}
              syncBus={syncBusRef.current}
              drawingManager={drawingManagerRef.current}
              reloadNonce={reloadNonce}
              externalBarsOverride={localFileOverride}
              onFocus={() => setActiveTileId(tile.id)}
              onToggleMaximize={() =>
                setMaximizedTileId((m) => (m === tile.id ? null : tile.id))
              }
              {...(tile.id === activeTile.id
                ? {
                    onTelemetry: setTelemetry,
                    onResolvedMeta: (info, label) => setActiveMeta({ info, label }),
                    controllerOutRef: activeControllerRef,
                  }
                : {})}
            />
          ))}
        </main>

        {rightTab === 'watchlist' && (
          <WatchlistPanel
            symbolIds={watchlist}
            activeSymbolId={activeTile.symbol}
            quotes={quotes}
            isDark={isDark}
            onSelect={(sym) => {
              setLocalFileOverride(null);
              setStress250k(false);
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
        onClose={() => setSearchOpen(false)}
        onSelect={(sym) => {
          setLocalFileOverride(null);
          setStress250k(false);
          updateActiveTile({ symbol: sym.id });
        }}
      />

      <ProviderVaultModal
        open={vaultOpen}
        client={clientRef.current!}
        bridgeOnline={bridge.mode === 'local_bridge'}
        {...(bridge.vaultMode ? { vaultMode: bridge.vaultMode } : {})}
        onClose={() => setVaultOpen(false)}
        onUpdated={() => setReloadNonce((n) => n + 1)}
      />
    </div>
  );
}
