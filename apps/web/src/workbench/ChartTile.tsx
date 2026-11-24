import { useEffect, useRef, useState } from 'react';
import {
  ChartController,
  generateSyntheticBars,
  type FrameTelemetry,
} from '@openview/chart-engine';
import { findSymbolById } from '@openview/datafeed-sdk';
import type { DrawingManager } from '@openview/drawings';
import type {
  ChartTileState,
  OHLCVBar,
  SymbolInfo,
} from '@openview/protocol';
import { loadBrowserWasm } from '@openview/script-runtime';
import type { MarketClient } from '../services/market-client.ts';
import type { WorkspaceSyncBus } from './sync-bus.ts';

interface ChartTileProps {
  tile: ChartTileState;
  isActive: boolean;
  isMaximized: boolean;
  bridgeOnlineMode: 'connecting' | 'local_bridge' | 'static_mode';
  theme: 'dark' | 'light';
  showRsiPane: boolean;
  stress250k: boolean;
  syncCrosshair: boolean;
  client: MarketClient;
  syncBus: WorkspaceSyncBus;
  drawingManager: DrawingManager;
  reloadNonce: number;
  externalBarsOverride?: { symbol: SymbolInfo; bars: OHLCVBar[]; label: string } | null;
  onFocus: () => void;
  onToggleMaximize: () => void;
  onTelemetry?: (t: FrameTelemetry) => void;
  onResolvedMeta?: (info: SymbolInfo, providerLabel: string) => void;
  controllerOutRef?: React.MutableRefObject<ChartController | null>;
}

const QUICK_COLORS = ['#2962ff', '#089981', '#f23645', '#f7931a', '#ab47bc', '#d1d4dc'];

export function ChartTile({
  tile,
  isActive,
  isMaximized,
  bridgeOnlineMode,
  theme,
  showRsiPane,
  stress250k,
  syncCrosshair,
  client,
  syncBus,
  drawingManager,
  reloadNonce,
  externalBarsOverride,
  onFocus,
  onToggleMaximize,
  onTelemetry,
  onResolvedMeta,
  controllerOutRef,
}: ChartTileProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<ChartController | null>(null);
  const symbolRef = useRef<SymbolInfo>(findSymbolById(tile.symbol)!);
  const [drawRev, setDrawRev] = useState(0);

  // Mount ChartController once per tile (strictly 2 canvases per tile!)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const initSym = findSymbolById(tile.symbol)!;
    symbolRef.current = initSym;

    const ctrl = new ChartController({
      symbol: initSym,
      resolution: tile.resolution,
      chartStyle: tile.chartStyle,
      priceScaleMode: tile.priceScaleMode,
      theme,
      showVolume: tile.showVolume,
    });
    ctrl.mount(el);
    controllerRef.current = ctrl;
    if (isActive && controllerOutRef) controllerOutRef.current = ctrl;

    // Bind committed & interactive drawing overlays onto the tile's 2 canvases
    ctrl.setOverlayRenderers(
      (ctx) => drawingManager.renderCommitted(ctx, symbolRef.current.id, ctrl.getMainCoordBridge()),
      (ctx) => drawingManager.renderDraftAndHandles(ctx, symbolRef.current.id, ctrl.getMainCoordBridge()),
    );

    ctrl.setPointerInterceptor({
      onDown: (x, y, paneId) => {
        onFocus();
        if (paneId !== 'main') return false;
        const handled = drawingManager.handlePointerDown(x, y, symbolRef.current.id, ctrl.getMainCoordBridge());
        if (handled) ctrl.requestRedraw(true);
        return handled;
      },
      onMove: (x, y) => {
        const handled = drawingManager.handlePointerMove(x, y, ctrl.getMainCoordBridge());
        if (handled) ctrl.requestRedraw(true);
        return handled;
      },
      onUp: () => {
        const handled = drawingManager.handlePointerUp();
        if (handled) ctrl.requestRedraw(true);
        return handled;
      },
    });

    ctrl.onLoadMoreHistory((beforeTime) => {
      client.requestMoreHistory(tile.id, beforeTime, 400);
    });

    const unsubDraw = drawingManager.onChange(() => {
      setDrawRev((r) => r + 1);
      ctrl.requestRedraw(true);
    });

    const unsubCrosshairOut = ctrl.subscribeCrosshair((ch) => {
      if (!syncCrosshair) return;
      const timeMs = ch.visible && ch.barIndex !== null ? ctrl.getBarTimeAt(ch.barIndex) : null;
      syncBus.emitCrosshair(tile.id, timeMs);
    });

    const unsubCrosshairIn = syncBus.onCrosshair((ev) => {
      if (ev.sourceTileId === tile.id || !syncCrosshair) return;
      ctrl.setExternalCrosshairTime(ev.timeMs);
    });

    const telemetryTimer = window.setInterval(() => {
      if (onTelemetry) onTelemetry(ctrl.getTelemetry());
    }, 350);

    return () => {
      window.clearInterval(telemetryTimer);
      unsubCrosshairOut();
      unsubCrosshairIn();
      unsubDraw();
      ctrl.destroy();
      controllerRef.current = null;
    };
    // Mount once per tile.id
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tile.id]);

  // Keep active controller ref synced
  useEffect(() => {
    if (isActive && controllerOutRef) {
      controllerOutRef.current = controllerRef.current;
    }
  }, [isActive, controllerOutRef]);

  const applyRsi = (ctrl: ChartController, bars: readonly OHLCVBar[]) => {
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

  // Subscribe datafeed (or local CSV/Parquet override / 250k stress test)
  useEffect(() => {
    const ctrl = controllerRef.current;
    if (!ctrl || bridgeOnlineMode === 'connecting') return;

    if (externalBarsOverride && isActive) {
      symbolRef.current = externalBarsOverride.symbol;
      ctrl.setSymbolInfo(externalBarsOverride.symbol, tile.resolution);
      ctrl.setBars(externalBarsOverride.bars, 160);
      applyRsi(ctrl, externalBarsOverride.bars);
      onResolvedMeta?.(externalBarsOverride.symbol, externalBarsOverride.label);
      return;
    }

    const sym = findSymbolById(tile.symbol);
    if (!sym) return;
    symbolRef.current = sym;

    if (stress250k && isActive) {
      const bars = generateSyntheticBars(sym, tile.resolution, 250_000, 99);
      ctrl.setSymbolInfo(sym, tile.resolution);
      ctrl.setBars(bars, 250_000);
      applyRsi(ctrl, bars);
      onResolvedMeta?.(sym, '250k Mipmap Benchmark');
      return;
    }

    const unsub = client.subscribeChart(tile.id, tile.symbol, tile.resolution, {
      onSnapshot: (resolvedInfo, bars, _noMore, label) => {
        symbolRef.current = resolvedInfo;
        ctrl.setSymbolInfo(resolvedInfo, tile.resolution);
        ctrl.setBars(bars, 140);
        applyRsi(ctrl, bars);
        onResolvedMeta?.(resolvedInfo, label);
      },
      onBarUpdate: (bar, quality) => {
        ctrl.upsertBar(bar);
        if (symbolRef.current.feedQuality !== quality) {
          symbolRef.current = { ...symbolRef.current, feedQuality: quality };
          onResolvedMeta?.(symbolRef.current, symbolRef.current.provider);
        }
      },
      onHistoryResult: (olderBars) => {
        if (olderBars.length > 0) ctrl.prependBars(olderBars);
      },
    });

    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tile.symbol, tile.resolution, bridgeOnlineMode, stress250k, showRsiPane, reloadNonce, externalBarsOverride]);

  useEffect(() => {
    controllerRef.current?.setChartStyle(tile.chartStyle);
  }, [tile.chartStyle]);

  useEffect(() => {
    controllerRef.current?.setPriceScaleMode(tile.priceScaleMode);
  }, [tile.priceScaleMode]);

  useEffect(() => {
    controllerRef.current?.setInverted(tile.inverted);
  }, [tile.inverted]);

  useEffect(() => {
    controllerRef.current?.setTheme(theme);
  }, [theme]);

  // Selected drawing floating style bar (rendered only on active tile when a drawing on this symbol is selected)
  void drawRev;
  const selectedDrawing = isActive ? drawingManager.getSelected() : null;
  const showFloatingStyleBar = selectedDrawing && selectedDrawing.symbol === symbolRef.current.id;

  return (
    <div
      onMouseDown={onFocus}
      className={`relative h-full w-full overflow-hidden border ${
        isActive
          ? 'border-[#2962ff]'
          : theme === 'dark'
            ? 'border-[#242936]'
            : 'border-[#dce0ea]'
      }`}
    >
      <div ref={containerRef} className="h-full w-full" />

      {/* Top-right tile quick-maximize button */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onToggleMaximize();
        }}
        className="absolute top-1.5 right-20 z-10 rounded bg-[#131722]/80 px-1.5 py-0.5 font-mono text-[10px] text-[#868993] hover:text-white"
        title="Maximize / Restore Pane (Alt+Enter)"
      >
        {isMaximized ? '❐' : '□'}
      </button>

      {/* Floating Contextual Drawing Style Toolbar */}
      {showFloatingStyleBar && selectedDrawing && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          className="absolute top-9 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-md border border-[#2a2e39] bg-[#131722]/95 px-2.5 py-1 text-xs shadow-xl"
        >
          <span className="font-mono text-[10px] text-[#787b86]">{selectedDrawing.type}</span>
          <div className="h-3.5 w-px bg-[#2a2e39]" />
          {QUICK_COLORS.map((c) => (
            <button
              key={c}
              onClick={() => drawingManager.updateStyle(selectedDrawing.id, { color: c })}
              className={`h-4 w-4 rounded-full border ${
                selectedDrawing.style.color === c ? 'border-white scale-110' : 'border-transparent'
              }`}
              style={{ background: c }}
            />
          ))}
          <div className="h-3.5 w-px bg-[#2a2e39]" />
          <button
            onClick={() =>
              drawingManager.updateStyle(selectedDrawing.id, {
                dashed: !selectedDrawing.style.dashed,
              })
            }
            className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
              selectedDrawing.style.dashed ? 'bg-[#2962ff]/25 text-[#6aa0ff]' : 'text-[#868993]'
            }`}
          >
            Dash
          </button>
          <button
            onClick={() => drawingManager.toggleLock(selectedDrawing.id)}
            className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
              selectedDrawing.locked ? 'bg-[#f7931a]/25 text-[#f7931a]' : 'text-[#868993]'
            }`}
          >
            {selectedDrawing.locked ? 'Locked' : 'Lock'}
          </button>
          <button
            onClick={() => drawingManager.deleteDrawing(selectedDrawing.id)}
            className="rounded px-1.5 py-0.5 font-mono text-[10px] text-[#f23645] hover:bg-[#f23645]/15"
          >
            Del
          </button>
        </div>
      )}
    </div>
  );
}
