import { useEffect, useRef, useState } from 'react';
import {
  ChartController,
  generateSyntheticBars,
  type FrameTelemetry,
} from '@openview/chart-engine';
import {
  buildHistoricalIntrabarFootprint,
  buildTpoProfile,
  buildVolumeProfile,
  evaluateSpreadBars,
  parseSpreadExpression,
  transformNonTimeBars,
  type NonTimeChartMode,
  type SpreadAlignmentMode,
} from '@openview/chart-types';
import { findSymbolById, refineSymbolPrecision } from '@openview/datafeed-sdk';
import type { PaperAccountSnapshot } from '@openview/broker-sdk';
import type { DrawingManager } from '@openview/drawings';
import type { ChartTileState, OHLCVBar, SymbolInfo } from '@openview/protocol';
import type { MasterReplayClock } from '@openview/replay-engine';
import {
  computeBuiltinIndicators,
  loadBrowserWasm,
  runCustomIndicatorScript,
  runPineScript,
} from '@openview/script-runtime';
import type { MarketClient } from '../services/market-client.ts';
import type { WorkspaceSyncBus } from './sync-bus.ts';

interface ChartTileProps {
  tile: ChartTileState;
  isActive: boolean;
  isMaximized: boolean;
  bridgeOnlineMode: 'connecting' | 'local_bridge' | 'static_mode';
  theme: 'dark' | 'light';
  chartMode: NonTimeChartMode;
  showVrvp: boolean;
  showFootprint: boolean;
  showTpo: boolean;
  spreadAlignment: SpreadAlignmentMode;
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
  paperAccount?: PaperAccountSnapshot;
  reloadNonce: number;
  externalBarsOverride?: { symbol: SymbolInfo; bars: OHLCVBar[]; label: string } | null;
  onFocus: () => void;
  onToggleMaximize: () => void;
  onTelemetry?: (t: FrameTelemetry) => void;
  onResolvedMeta?: (info: SymbolInfo, providerLabel: string) => void;
  onBarsLoaded?: (bars: OHLCVBar[], info: SymbolInfo) => void;
  onLiveBarTick?: (symbolId: string, bar: OHLCVBar) => void;
  onScriptOutput?: (logs: string[], elapsedMs: number, error?: string) => void;
  controllerOutRef?: React.MutableRefObject<ChartController | null>;
}

const QUICK_COLORS = ['#2962ff', '#089981', '#f23645', '#f7931a', '#ab47bc', '#d1d4dc'];

function makeSpreadSymbol(expr: string): SymbolInfo {
  return {
    id: `SPREAD:${expr}`,
    ticker: expr,
    description: `Synthetic Spread (${expr})`,
    exchange: 'SPREAD',
    provider: 'synthetic_spread',
    market: 'index',
    segment: 'index',
    currency: 'RATIO',
    timezone: 'UTC',
    calendarId: 'CRYPTO',
    tickSize: 0.001,
    precision: 3,
    lotSize: 1,
    hasVolume: false,
    supportsOrderbook: false,
    supportsTicks: false,
    feedQuality: 'live_quote_zero_vol',
    symlogLinthresh: 0.1,
  };
}

export function ChartTile({
  tile,
  isActive,
  isMaximized,
  bridgeOnlineMode,
  theme,
  chartMode,
  showVrvp,
  showFootprint,
  showTpo,
  spreadAlignment,
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
  paperAccount,
  reloadNonce,
  externalBarsOverride,
  onFocus,
  onToggleMaximize,
  onTelemetry,
  onResolvedMeta,
  onBarsLoaded,
  onLiveBarTick,
  onScriptOutput,
  controllerOutRef,
}: ChartTileProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<ChartController | null>(null);
  const symbolRef = useRef<SymbolInfo>(
    tile.symbol.startsWith('SPREAD:')
      ? makeSpreadSymbol(tile.symbol.slice('SPREAD:'.length))
      : findSymbolById(tile.symbol) ?? findSymbolById('BINANCE:BTCUSDT')!,
  );
  const rawBarsRef = useRef<OHLCVBar[]>([]);
  const barsRef = useRef<OHLCVBar[]>([]);
  const paperAccountRef = useRef<PaperAccountSnapshot | undefined>(paperAccount);
  paperAccountRef.current = paperAccount;
  const overlayFlagsRef = useRef({ showVrvp, showFootprint, showTpo });
  overlayFlagsRef.current = { showVrvp, showFootprint, showTpo };
  const mountedSubPanesRef = useRef<Set<string>>(new Set());
  const subGenRef = useRef(0);
  const liveIndicatorTimerRef = useRef<number | null>(null);
  const lastTelemetryStrRef = useRef('');
  const [drawRev, setDrawRev] = useState(0);

  // Mount ChartController once per tile (strictly 2 canvases per tile!)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const initSym = tile.symbol.startsWith('SPREAD:')
      ? makeSpreadSymbol(tile.symbol.slice('SPREAD:'.length))
      : findSymbolById(tile.symbol) ?? findSymbolById('BINANCE:BTCUSDT')!;
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
      (ctx) => {
        const bridge = ctrl.getMainCoordBridge();
        const flags = overlayFlagsRef.current;

        // ── Institutional Orderflow & Market Profile Overlays (Zero extra DOM canvases!) ──
        if (flags.showVrvp || flags.showFootprint || flags.showTpo) {
          const vis = ctrl.getVisibleBarRange();
          if (vis) {
            const visibleBars: OHLCVBar[] = [];
            for (let idx = vis.from; idx <= vis.to; idx++) {
              const b = bridge.getBar(idx);
              if (b) visibleBars.push(b);
            }

            if (visibleBars.length > 0) {
              ctx.save();
              ctx.setTransform(bridge.horizontalPixelRatio, 0, 0, bridge.verticalPixelRatio, 0, 0);
              ctx.beginPath();
              ctx.rect(bridge.paneRect.x, bridge.paneRect.y, bridge.paneRect.width, bridge.paneRect.height);
              ctx.clip();

              // 1. Visible Range Volume Profile (VRVP) docked on right edge
              if (flags.showVrvp) {
                const vp = buildVolumeProfile(visibleBars, 28);
                const maxBarW = Math.min(130, bridge.paneRect.width * 0.22);
                const rightX = bridge.paneRect.x + bridge.paneRect.width - 2;
                for (const row of vp.rows) {
                  if (vp.maxRowVol <= 0) continue;
                  const yTop = bridge.priceToY(row.priceHigh);
                  const yBot = bridge.priceToY(row.priceLow);
                  const h = Math.max(1.5, Math.abs(yBot - yTop) - 1);
                  const totalW = (row.totalVol / vp.maxRowVol) * maxBarW;
                  const upW = row.totalVol > 0 ? (row.upVol / row.totalVol) * totalW : 0;
                  const dnW = totalW - upW;
                  const inVa = row.price >= vp.val && row.price <= vp.vah;

                  ctx.fillStyle = inVa ? 'rgba(8, 153, 129, 0.34)' : 'rgba(8, 153, 129, 0.14)';
                  ctx.fillRect(rightX - totalW, Math.min(yTop, yBot), upW, h);
                  ctx.fillStyle = inVa ? 'rgba(242, 54, 69, 0.34)' : 'rgba(242, 54, 69, 0.14)';
                  ctx.fillRect(rightX - dnW, Math.min(yTop, yBot), dnW, h);
                }

                // POC + VAH / VAL lines
                const pocY = bridge.priceToY(vp.pocPrice);
                ctx.strokeStyle = '#f7931a';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(bridge.paneRect.x, pocY);
                ctx.lineTo(rightX, pocY);
                ctx.stroke();

                ctx.save();
                ctx.setLineDash([4, 4]);
                ctx.strokeStyle = 'rgba(41, 98, 255, 0.65)';
                ctx.lineWidth = 1;
                for (const level of [vp.vah, vp.val]) {
                  const ly = bridge.priceToY(level);
                  ctx.beginPath();
                  ctx.moveTo(bridge.paneRect.x, ly);
                  ctx.lineTo(rightX, ly);
                  ctx.stroke();
                }
                ctx.restore();
              }

              // 2. Historical 1m-Intrabar Footprint Cluster Overlay (Honest Approx Badge)
              if (flags.showFootprint) {
                const slice = visibleBars.slice(-20);
                const startIdx = Math.max(vis.from, vis.to - slice.length + 1);
                let minP = Infinity;
                let maxP = -Infinity;
                for (const b of slice) {
                  if (b.low < minP) minP = b.low;
                  if (b.high > maxP) maxP = b.high;
                }
                const step = Math.max(symbolRef.current.tickSize, (maxP - minP) / 14);
                const fps = buildHistoricalIntrabarFootprint(slice, step);
                ctx.font = '600 9px monospace';
                ctx.textBaseline = 'middle';

                for (let k = 0; k < fps.length; k++) {
                  const fp = fps[k]!;
                  const cx = bridge.indexToX(startIdx + k);
                  for (const row of fp.rows) {
                    const y = bridge.priceToY(row.price);
                    const isPoc = Math.abs(row.price - fp.pocPrice) <= step * 0.5;
                    ctx.fillStyle = row.buyImbalance
                      ? 'rgba(8, 153, 129, 0.45)'
                      : row.sellImbalance
                        ? 'rgba(242, 54, 69, 0.45)'
                        : 'rgba(30, 34, 45, 0.72)';
                    ctx.fillRect(cx - 24, y - 6, 48, 12);
                    if (isPoc) {
                      ctx.strokeStyle = '#f7931a';
                      ctx.lineWidth = 1;
                      ctx.strokeRect(cx - 24, y - 6, 48, 12);
                    }
                    ctx.fillStyle = '#e5e7eb';
                    ctx.textAlign = 'center';
                    ctx.fillText(
                      `${Math.round(row.bidVol)}×${Math.round(row.askVol)}`,
                      cx,
                      y,
                    );
                  }
                }

                // Honest Mode B indicator badge
                ctx.fillStyle = 'rgba(247, 147, 26, 0.22)';
                ctx.fillRect(bridge.paneRect.x + 10, bridge.paneRect.y + 34, 188, 18);
                ctx.fillStyle = '#f7931a';
                ctx.textAlign = 'left';
                ctx.fillText('FOOTPRINT · 1M INTRABAR (APPROX)', bridge.paneRect.x + 16, bridge.paneRect.y + 43);
              }

              // 3. TPO Market Profile Letters + Initial Balance Bracket
              if (flags.showTpo) {
                const tpo = buildTpoProfile(visibleBars);
                const leftX = bridge.paneRect.x + 12;
                ctx.font = '700 9.5px monospace';
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';

                // Initial Balance (IB) vertical bar
                const ibTop = bridge.priceToY(tpo.ibHigh);
                const ibBot = bridge.priceToY(tpo.ibLow);
                ctx.strokeStyle = '#2962ff';
                ctx.lineWidth = 3;
                ctx.beginPath();
                ctx.moveTo(leftX - 5, ibTop);
                ctx.lineTo(leftX - 5, ibBot);
                ctx.stroke();

                for (const row of tpo.rows) {
                  const y = bridge.priceToY(row.price);
                  const isPoc = Math.abs(row.price - tpo.pocPrice) < 1e-6;
                  ctx.fillStyle = isPoc
                    ? '#f7931a'
                    : row.isSinglePrint
                      ? '#ab47bc'
                      : row.price >= tpo.val && row.price <= tpo.vah
                        ? '#5b9cf6'
                        : '#787b86';
                  ctx.fillText(row.letters.slice(0, 18).join(''), leftX, y);
                }
              }

              ctx.restore();
            }
          }
        }

        // Vector Drawings
        drawingManager.renderCommitted(ctx, symbolRef.current.id, bridge);

        // On-chart Visual Trading: render open Paper Position & Working Limit/SL/TP Order lines
        const acct = paperAccountRef.current;
        if (!acct) return;
        const symId = symbolRef.current.id;
        ctx.save();
        ctx.setTransform(bridge.horizontalPixelRatio, 0, 0, bridge.verticalPixelRatio, 0, 0);

        const drawPriceBadgeLine = (price: number, color: string, label: string, dashed = false) => {
          const y = bridge.priceToY(price);
          if (y < bridge.paneRect.y || y > bridge.paneRect.y + bridge.paneRect.height) return;
          ctx.save();
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.25;
          if (dashed) ctx.setLineDash([5, 3]);
          ctx.beginPath();
          ctx.moveTo(bridge.paneRect.x, y);
          ctx.lineTo(bridge.paneRect.x + bridge.paneRect.width, y);
          ctx.stroke();

          ctx.font = '600 10.5px monospace';
          const tw = ctx.measureText(label).width + 12;
          const bx = bridge.paneRect.x + bridge.paneRect.width - tw - 10;
          ctx.fillStyle = color;
          ctx.fillRect(bx, y - 9, tw, 18);
          ctx.fillStyle = '#ffffff';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, bx + 6, y + 0.5);
          ctx.restore();
        };

        const pos = acct.positions.find((p) => p.symbol === symId);
        if (pos) {
          const pnlSign = pos.unrealizedPnl >= 0 ? '+' : '';
          drawPriceBadgeLine(
            pos.avgEntryPrice,
            pos.side === 'long' ? '#089981' : '#f23645',
            `${pos.side.toUpperCase()} ${pos.quantity} · ${pnlSign}${pos.unrealizedPnl.toFixed(2)}`,
            false,
          );
        }

        for (const ord of acct.workingOrders) {
          if (ord.symbol !== symId || ord.price === undefined) continue;
          const color =
            ord.role === 'sl'
              ? '#f23645'
              : ord.role === 'tp'
                ? '#089981'
                : ord.side === 'buy'
                  ? '#2962ff'
                  : '#f7931a';
          const tag =
            ord.role === 'sl'
              ? `SL ${ord.quantity}`
              : ord.role === 'tp'
                ? `TP ${ord.quantity}`
                : `${ord.side.toUpperCase()} ${ord.type.toUpperCase()} ${ord.quantity}`;
          drawPriceBadgeLine(ord.price, color, tag, true);
        }
        ctx.restore();
      },
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
      if (!replayActive && !tile.symbol.startsWith('SPREAD:')) {
        client.requestMoreHistory(tile.id, beforeTime, 400);
      }
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
      if (!onTelemetry) return;
      const t = ctrl.getTelemetry();
      const key = `${t.medianFrameMs}|${t.drawnBars}|${t.totalBars}`;
      if (key !== lastTelemetryStrRef.current) {
        lastTelemetryStrRef.current = key;
        onTelemetry(t);
      }
    }, 750);

    return () => {
      window.clearInterval(telemetryTimer);
      if (liveIndicatorTimerRef.current !== null) {
        window.clearTimeout(liveIndicatorTimerRef.current);
        liveIndicatorTimerRef.current = null;
      }
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
    const startBarIndex = ctrl.getFirstBarIndex();
    void loadBrowserWasm()
      .then((wasm) => {
        const computed = computeBuiltinIndicators(wasm, activeIndicatorIds, bars, info, startBarIndex);
        const overlays = [...computed.overlays];
        const subPanes = [...computed.subPanes];

        if (customScriptCode && isActive) {
          const isPine =
            customScriptCode.includes('//@version=') ||
            /\b(indicator|strategy)\s*\(/.test(customScriptCode);
          const customRes = isPine
            ? runPineScript(customScriptCode, bars, wasm)
            : runCustomIndicatorScript(customScriptCode, bars, wasm);
          for (const ov of customRes.overlays) {
            overlays.push({ ...ov, startBarIndex });
          }
          if (customRes.subPanePlots.length > 0) {
            subPanes.push({
              paneId: 'custom_script',
              plots: customRes.subPanePlots.map((p) => ({ ...p, startBarIndex })),
            });
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

  const scheduleLiveIndicatorRecompute = (ctrl: ChartController) => {
    // Coalesce live indicator refreshes (450ms) so Rust/WASM indicators tick live smoothly with zero lag
    if (liveIndicatorTimerRef.current !== null || barsRef.current.length > 5000) return;
    liveIndicatorTimerRef.current = window.setTimeout(() => {
      liveIndicatorTimerRef.current = null;
      if (controllerRef.current === ctrl && barsRef.current.length > 0) {
        recomputeIndicators(ctrl, barsRef.current, symbolRef.current);
      }
    }, 450);
  };

  const applyModeAndRender = (
    ctrl: ChartController,
    raw: OHLCVBar[],
    info: SymbolInfo,
    fitCount = 140,
  ) => {
    const tailClose = raw[raw.length - 1]?.close;
    const refinedInfo = tailClose !== undefined ? refineSymbolPrecision(info, tailClose) : info;
    symbolRef.current = refinedInfo;
    rawBarsRef.current = raw;
    const displayBars = chartMode === 'standard' ? raw : transformNonTimeBars(raw, chartMode);
    barsRef.current = displayBars;
    ctrl.setSymbolInfo(refinedInfo, tile.resolution);
    ctrl.setBars(displayBars, Math.min(fitCount, Math.max(40, displayBars.length)));
    recomputeIndicators(ctrl, displayBars, refinedInfo);
    onBarsLoaded?.(displayBars, refinedInfo);
  };

  // Master-Clock Multi-TF Replay override
  useEffect(() => {
    const ctrl = controllerRef.current;
    if (!ctrl || !replayActive) return;
    const rolled = replayClock.getRolledUpSeries(tile.resolution, symbolRef.current.calendarId);
    const replayInfo: SymbolInfo = { ...symbolRef.current, feedQuality: 'replay' };
    applyModeAndRender(ctrl, rolled, replayInfo, 160);
    onResolvedMeta?.(replayInfo, 'Master-Clock Replay');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replayActive, replayTickNonce, tile.resolution, chartMode]);

  // Live / Historical / Synthetic Spread Datafeed Subscription
  useEffect(() => {
    const ctrl = controllerRef.current;
    if (!ctrl || bridgeOnlineMode === 'connecting' || replayActive) return;

    if (externalBarsOverride && isActive) {
      symbolRef.current = externalBarsOverride.symbol;
      applyModeAndRender(ctrl, externalBarsOverride.bars, externalBarsOverride.symbol, 160);
      onResolvedMeta?.(externalBarsOverride.symbol, externalBarsOverride.label);
      return;
    }

    // Synthetic Spread Mode (e.g., SPREAD:FX:XAUUSD/FX:XAGUSD)
    if (tile.symbol.startsWith('SPREAD:')) {
      const expr = tile.symbol.slice('SPREAD:'.length);
      const spreadInfo = makeSpreadSymbol(expr);
      symbolRef.current = spreadInfo;
      let cancelled = false;

      void (async () => {
        try {
          const parsed = parseSpreadExpression(expr);
          const legSeries: Record<string, OHLCVBar[]> = {};
          await Promise.all(
            parsed.symbols.map(async (legSym) => {
              const res = await client.fetchHistory(legSym, tile.resolution, 400);
              if (res) legSeries[legSym] = res.bars;
            }),
          );
          if (cancelled) return;
          const spreadBars = evaluateSpreadBars(expr, legSeries, spreadAlignment);
          applyModeAndRender(ctrl, spreadBars, spreadInfo, 160);
          onResolvedMeta?.(spreadInfo, `Synthetic Spread (${spreadAlignment})`);
        } catch {
          // ignore malformed spread
        }
      })();

      return () => {
        cancelled = true;
      };
    }

    const sym = findSymbolById(tile.symbol);
    if (!sym) return;
    symbolRef.current = sym;

    if (stress250k && isActive) {
      const bars = generateSyntheticBars(sym, tile.resolution, 250_000, 99);
      applyModeAndRender(ctrl, bars, sym, 250_000);
      onResolvedMeta?.(sym, '250k Mipmap Benchmark');
      return;
    }

    const gen = ++subGenRef.current;
    const unsub = client.subscribeChart(tile.id, tile.symbol, tile.resolution, {
      onSnapshot: (resolvedInfo, bars, noMore, label) => {
        if (subGenRef.current !== gen) return;
        symbolRef.current = resolvedInfo;
        applyModeAndRender(ctrl, bars, resolvedInfo, 140);
        ctrl.setNoMoreHistory(noMore);
        onResolvedMeta?.(symbolRef.current, label);
      },
      onBarUpdate: (bar, quality) => {
        if (subGenRef.current !== gen) return;
        if (
          !Number.isFinite(bar.time) ||
          !Number.isFinite(bar.open) ||
          !Number.isFinite(bar.high) ||
          !Number.isFinite(bar.low) ||
          !Number.isFinite(bar.close)
        ) {
          return;
        }
        const rawList = rawBarsRef.current;
        if (rawList.length > 0) {
          const lastTime = rawList[rawList.length - 1]!.time;
          // Strictly reject stale/out-of-order timestamps so chart NEVER appends duplicate backwards bars
          if (bar.time < lastTime) return;
          if (bar.time === lastTime) {
            rawList[rawList.length - 1] = bar;
          } else {
            rawList.push(bar);
          }
        } else {
          rawList.push(bar);
        }

        if (chartMode === 'standard') {
          ctrl.upsertBar(bar);
          barsRef.current = rawList;
          scheduleLiveIndicatorRecompute(ctrl);
        } else {
          const transformed = transformNonTimeBars(rawList, chartMode);
          barsRef.current = transformed;
          ctrl.updateBarsPreserveView(transformed);
          scheduleLiveIndicatorRecompute(ctrl);
        }
        onLiveBarTick?.(symbolRef.current.id, bar);

        if (symbolRef.current.feedQuality !== quality) {
          symbolRef.current = { ...symbolRef.current, feedQuality: quality };
          onResolvedMeta?.(symbolRef.current, symbolRef.current.provider);
        }
      },
      onHistoryResult: (olderBars, noMore) => {
        if (subGenRef.current !== gen) return;
        const oldestTime = rawBarsRef.current[0]?.time ?? Infinity;
        const freshOlder = olderBars.filter((b) => b.time < oldestTime);
        if (freshOlder.length > 0) {
          rawBarsRef.current = [...freshOlder, ...rawBarsRef.current];
          if (chartMode === 'standard') {
            barsRef.current = rawBarsRef.current;
            ctrl.prependBars(freshOlder);
            recomputeIndicators(ctrl, barsRef.current, symbolRef.current);
          } else {
            applyModeAndRender(ctrl, rawBarsRef.current, symbolRef.current, 160);
          }
        }
        ctrl.setNoMoreHistory(noMore || freshOlder.length === 0);
      },
    });

    return () => {
      subGenRef.current++;
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tile.symbol, tile.resolution, bridgeOnlineMode, stress250k, reloadNonce, externalBarsOverride, replayActive, spreadAlignment]);

  // Re-transform bars immediately when chartMode switches (Standard <-> Renko/Range/Kagi/P&F/3LB)
  useEffect(() => {
    const ctrl = controllerRef.current;
    if (!ctrl || rawBarsRef.current.length === 0) return;
    applyModeAndRender(ctrl, rawBarsRef.current, symbolRef.current, 140);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartMode]);

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

  useEffect(() => {
    controllerRef.current?.requestRedraw(true);
  }, [paperAccount, showVrvp, showFootprint, showTpo]);

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
