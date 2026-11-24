import { useEffect, useRef, useState } from 'react';
import {
  ChartController,
  generateSyntheticBars,
  type FrameTelemetry,
} from '@openview/chart-engine';
import { findSymbolById } from '@openview/datafeed-sdk';
import type { DrawingManager } from '@openview/drawings';
import type { ChartTileState, OHLCVBar, SymbolInfo } from '@openview/protocol';
import type { MasterReplayClock } from '@openview/replay-engine';
import {
  computeBuiltinIndicators,
  loadBrowserWasm,
  runCustomIndicatorScript,
} from '@openview/script-runtime';
import type { MarketClient } from '../services/market-client.ts';
import type { WorkspaceSyncBus } from './sync-bus.ts';

interface ChartTileProps {
  tile: ChartTileState;
  isActive: boolean;
  isMaximized: boolean;
  bridgeOnlineMode: 'connecting' | 'local_bridge' | 'static_mode';
  theme: 'dark' | 'light';
  activeIndicatorIds: string[];
  customScriptCode: string | null;
  scriptRunNonce: number;
  stress250k: boolean;
  syncCrosshair: boolean;
  replayActive: boolean;
  replayClock: MasterReplayClock;
  replayTickNonce: number;
  client: MarketClient;
  syncBus: WorkspaceSyncBus;
  drawingManager: DrawingManager;
  reloadNonce: number;
  externalBarsOverride?: { symbol: SymbolInfo; bars: OHLCVBar[]; label: string } | null;
  onFocus: () => void;
  onToggleMaximize: () => void;
  onTelemetry?: (t: FrameTelemetry) => void;
  onResolvedMeta?: (info: SymbolInfo, providerLabel: string) => void;
  onBarsLoaded?: (bars: OHLCVBar[], info: SymbolInfo) => void;
  onScriptOutput?: (logs: string[], elapsedMs: number, error?: string) => void;
  controllerOutRef?: React.MutableRefObject<ChartController | null>;
}

const QUICK_COLORS = ['#2962ff', '#089981', '#f23645', '#f7931a', '#ab47bc', '#d1d4dc'];

export function ChartTile({
  tile,
  isActive,
  isMaximized,
  bridgeOnlineMode,
  theme,
  activeIndicatorIds,
  customScriptCode,
  scriptRunNonce,
  stress250k,
  syncCrosshair,
  replayActive,
  replayClock,
  replayTickNonce,
  client,
  syncBus,
  drawingManager,
  reloadNonce,
  externalBarsOverride,
  onFocus,
  onToggleMaximize,
  onTelemetry,
  onResolvedMeta,
  onBarsLoaded,
  onScriptOutput,
  controllerOutRef,
}: ChartTileProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<ChartController | null>(null);
  const symbolRef = useRef<SymbolInfo>(findSymbolById(tile.symbol)!);
  const barsRef = useRef<OHLCVBar[]>([]);
  const mountedSubPanesRef = useRef<Set<string>>(new Set());
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
      if (!replayActive) client.requestMoreHistory(tile.id, beforeTime, 400);
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

  useEffect(() => {
    if (isActive && controllerOutRef) {
      controllerOutRef.current = controllerRef.current;
    }
  }, [isActive, controllerOutRef]);

  const recomputeIndicators = (ctrl: ChartController, bars: readonly OHLCVBar[], info: SymbolInfo) => {
    void loadBrowserWasm()
      .then((wasm) => {
        const computed = computeBuiltinIndicators(wasm, activeIndicatorIds, bars, info);
        const overlays = [...computed.overlays];
        const subPanes = [...computed.subPanes];

        if (customScriptCode && isActive) {
          const customRes = runCustomIndicatorScript(customScriptCode, bars, wasm);
          overlays.push(...customRes.overlays);
          if (customRes.subPanePlots.length > 0) {
            subPanes.push({ paneId: 'custom_script', plots: customRes.subPanePlots });
          }
          onScriptOutput?.(customRes.logs, customRes.elapsedMs, customRes.error);
        }

        ctrl.setMainOverlays(overlays);

        const nextPaneIds = new Set(subPanes.map((s) => s.paneId));
        for (const existing of [...mountedSubPanesRef.current]) {
          if (!nextPaneIds.has(existing)) {
            ctrl.removeSubPane(existing);
            mountedSubPanesRef.current.delete(existing);
          }
        }
        for (const sp of subPanes) {
          if (!mountedSubPanesRef.current.has(sp.paneId)) {
            ctrl.addSubPane(sp.paneId, 0.22, 2);
            mountedSubPanesRef.current.add(sp.paneId);
          }
          ctrl.setSubPanePlots(sp.paneId, sp.plots, sp.fixedRange);
        }
      })
      .catch(() => {});
  };

  // Master-Clock Multi-TF Replay override
  useEffect(() => {
    const ctrl = controllerRef.current;
    if (!ctrl || !replayActive) return;
    const rolled = replayClock.getRolledUpSeries(tile.resolution, symbolRef.current.calendarId);
    barsRef.current = rolled;
    const replayInfo: SymbolInfo = { ...symbolRef.current, feedQuality: 'replay' };
    ctrl.setSymbolInfo(replayInfo, tile.resolution);
    ctrl.setBars(rolled, Math.min(160, Math.max(40, rolled.length)));
    recomputeIndicators(ctrl, rolled, replayInfo);
    onResolvedMeta?.(replayInfo, 'Master-Clock Replay');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replayActive, replayTickNonce, tile.resolution]);

  // Live / Historical Datafeed Subscription
  useEffect(() => {
    const ctrl = controllerRef.current;
    if (!ctrl || bridgeOnlineMode === 'connecting' || replayActive) return;

    if (externalBarsOverride && isActive) {
      symbolRef.current = externalBarsOverride.symbol;
      barsRef.current = externalBarsOverride.bars;
      ctrl.setSymbolInfo(externalBarsOverride.symbol, tile.resolution);
      ctrl.setBars(externalBarsOverride.bars, 160);
      recomputeIndicators(ctrl, externalBarsOverride.bars, externalBarsOverride.symbol);
      onResolvedMeta?.(externalBarsOverride.symbol, externalBarsOverride.label);
      onBarsLoaded?.(externalBarsOverride.bars, externalBarsOverride.symbol);
      return;
    }

    const sym = findSymbolById(tile.symbol);
    if (!sym) return;
    symbolRef.current = sym;

    if (stress250k && isActive) {
      const bars = generateSyntheticBars(sym, tile.resolution, 250_000, 99);
      barsRef.current = bars;
      ctrl.setSymbolInfo(sym, tile.resolution);
      ctrl.setBars(bars, 250_000);
      recomputeIndicators(ctrl, bars, sym);
      onResolvedMeta?.(sym, '250k Mipmap Benchmark');
      onBarsLoaded?.(bars, sym);
      return;
    }

    const unsub = client.subscribeChart(tile.id, tile.symbol, tile.resolution, {
      onSnapshot: (resolvedInfo, bars, _noMore, label) => {
        symbolRef.current = resolvedInfo;
        barsRef.current = bars;
        ctrl.setSymbolInfo(resolvedInfo, tile.resolution);
        ctrl.setBars(bars, 140);
        recomputeIndicators(ctrl, bars, resolvedInfo);
        onResolvedMeta?.(resolvedInfo, label);
        onBarsLoaded?.(bars, resolvedInfo);
      },
      onBarUpdate: (bar, quality) => {
        ctrl.upsertBar(bar);
        const list = barsRef.current;
        if (list.length > 0 && list[list.length - 1]!.time === bar.time) {
          list[list.length - 1] = bar;
        } else {
          list.push(bar);
        }
        if (symbolRef.current.feedQuality !== quality) {
          symbolRef.current = { ...symbolRef.current, feedQuality: quality };
          onResolvedMeta?.(symbolRef.current, symbolRef.current.provider);
        }
      },
      onHistoryResult: (olderBars) => {
        if (olderBars.length > 0) {
          barsRef.current = [...olderBars, ...barsRef.current];
          ctrl.prependBars(olderBars);
          recomputeIndicators(ctrl, barsRef.current, symbolRef.current);
        }
      },
    });

    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tile.symbol, tile.resolution, bridgeOnlineMode, stress250k, reloadNonce, externalBarsOverride, replayActive]);

  // Recompute WASM indicators whenever indicator list or custom script changes
  useEffect(() => {
    const ctrl = controllerRef.current;
    if (!ctrl || barsRef.current.length === 0) return;
    recomputeIndicators(ctrl, barsRef.current, symbolRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndicatorIds, customScriptCode, scriptRunNonce]);

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
                selectedDrawing.style.color === c ? 'scale-110 border-white' : 'border-transparent'
              }`}
              style={{ background: c }}
            />
          ))}
          <div className="h-3.5 w-px bg-[#2a2e39]" />
          <button
            onClick={() =>
              drawingManager.updateStyle(selectedDrawing.id, { dashed: !selectedDrawing.style.dashed })
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
