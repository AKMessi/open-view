import type {
  ChartStyle,
  OHLCVBar,
  PriceScaleMode,
  Resolution,
  SymbolInfo,
} from '@openview/protocol';
import {
  DirtyFlag,
  DirtyScheduler,
  PaneLayoutSolver,
  TileCanvasPair,
  type PaneSpec,
  type TileLayout,
} from '../canvas/tile-canvas-pair.ts';
import { GestureController } from '../input/gesture-controller.ts';
import { MipmapPlotList } from '../model/mipmap-plot-list.ts';
import { SymlogPriceScale } from '../model/price-scale.ts';
import { SessionCalendar } from '../model/session-calendar.ts';
import { TimeScale } from '../model/time-scale.ts';
import {
  renderBaseLayer,
  renderTopLayer,
  type CrosshairState,
  type MainOverlayPlot,
  type SubPaneSeriesPlot,
} from '../renderers/pane-renderers.ts';
import { DARK_THEME, LIGHT_THEME, type ChartTheme } from '../renderers/theme.ts';

export interface FrameTelemetry {
  lastFrameMs: number;
  medianFrameMs: number;
  drawnBars: number;
  totalBars: number;
  mipmapStride: number;
  dpr: number;
}

export interface ChartControllerOptions {
  symbol: SymbolInfo;
  resolution?: Resolution;
  chartStyle?: ChartStyle;
  priceScaleMode?: PriceScaleMode;
  theme?: 'dark' | 'light';
  showVolume?: boolean;
  showSessionBreaks?: boolean;
}

/**
 * Framework-agnostic imperative Chart Controller (zero React dependency).
 * Owns exactly TWO canvases per chart tile, scissor-clipped multi-pane viewports,
 * MipmapPlotList, TimeScale, SymlogPriceScale, SessionCalendar, and GestureController.
 */
export class ChartController {
  private readonly plotList = new MipmapPlotList();
  private readonly timeScale = new TimeScale();
  private readonly mainPriceScale: SymlogPriceScale;
  private readonly calendar = new SessionCalendar();
  private readonly layoutSolver = new PaneLayoutSolver();

  private readonly paneSpecs: PaneSpec[] = [{ id: 'main', weight: 1, minHeightPx: 120 }];
  private readonly subPanes = new Map<string, { priceScale: SymlogPriceScale; plots: SubPaneSeriesPlot[] }>();
  private mainOverlays: MainOverlayPlot[] = [];

  private canvasPair: TileCanvasPair | null = null;
  private gestures: GestureController | null = null;
  private scheduler: DirtyScheduler;

  private symbol: SymbolInfo;
  private resolution: Resolution;
  private chartStyle: ChartStyle;
  private showVolume: boolean;
  private showSessionBreaks: boolean;
  private theme: ChartTheme;

  private layout: TileLayout;
  private crosshair: CrosshairState = {
    visible: false,
    x: 0,
    y: 0,
    paneId: 'main',
    barIndex: null,
    price: null,
  };
  private hoveredDividerIndex: number | null = null;

  private frameHistoryMs: number[] = [];
  private lastTelemetry: FrameTelemetry = {
    lastFrameMs: 0,
    medianFrameMs: 0,
    drawnBars: 0,
    totalBars: 0,
    mipmapStride: 1,
    dpr: 1,
  };

  private crosshairListeners = new Set<(state: CrosshairState) => void>();
  private loadMoreListeners = new Set<(beforeTime: number) => void>();
  private loadMorePending = false;
  private onBaseOverlay: ((ctx: CanvasRenderingContext2D) => void) | undefined;
  private onTopOverlay: ((ctx: CanvasRenderingContext2D) => void) | undefined;
  private pointerInterceptor: {
    onDown: (x: number, y: number, paneId: string) => boolean;
    onMove: (x: number, y: number) => boolean;
    onUp: () => boolean;
  } | null = null;

  constructor(options: ChartControllerOptions) {
    this.symbol = options.symbol;
    this.resolution = options.resolution ?? '15';
    this.chartStyle = options.chartStyle ?? 'candles';
    this.showVolume = options.showVolume ?? true;
    this.showSessionBreaks = options.showSessionBreaks ?? true;
    this.theme = options.theme === 'light' ? LIGHT_THEME : DARK_THEME;

    this.mainPriceScale = new SymlogPriceScale({
      mode: options.priceScaleMode ?? 'linear',
      tickSize: this.symbol.tickSize,
      precision: this.symbol.precision,
      ...(this.symbol.symlogLinthresh !== undefined ? { symlogLinthresh: this.symbol.symlogLinthresh } : {}),
    });

    this.layout = this.layoutSolver.solve(800, 500, this.paneSpecs);
    this.scheduler = new DirtyScheduler((mask) => this.renderFrame(mask));
  }

  mount(container: HTMLElement): void {
    this.unmount();
    this.canvasPair = new TileCanvasPair(container, (m) => {
      this.recomputeLayout(m.mediaWidth, m.mediaHeight);
      this.scheduler.invalidate(DirtyFlag.FULL | DirtyFlag.CURSOR);
    });

    const m = this.canvasPair.metrics;
    this.recomputeLayout(m.mediaWidth, m.mediaHeight);

    this.gestures = new GestureController(container, {
      getLayout: () => this.layout,
      onPan: (dx, dy, paneId) => {
        this.timeScale.scrollByPixels(dx, this.plotList.firstIndex());
        if (paneId === 'main') {
          this.mainPriceScale.panByPixels(dy);
        } else {
          this.subPanes.get(paneId)?.priceScale.panByPixels(dy);
        }
        this.checkLoadMoreHistory();
        this.scheduler.invalidate(DirtyFlag.FULL | DirtyFlag.CURSOR);
      },
      onZoomX: (anchorX, factor) => {
        this.timeScale.zoomAtCoordinate(anchorX, factor, this.plotList.firstIndex());
        this.checkLoadMoreHistory();
        this.scheduler.invalidate(DirtyFlag.FULL | DirtyFlag.CURSOR);
      },
      onScalePriceAxis: (paneId, dy) => {
        const scale = paneId === 'main' ? this.mainPriceScale : this.subPanes.get(paneId)?.priceScale;
        scale?.scaleByDrag(dy);
        this.scheduler.invalidate(DirtyFlag.FULL | DirtyFlag.CURSOR);
      },
      onResetPriceAxis: (paneId) => {
        const scale = paneId === 'main' ? this.mainPriceScale : this.subPanes.get(paneId)?.priceScale;
        scale?.setAutoScale(true);
        this.scheduler.invalidate(DirtyFlag.FULL | DirtyFlag.CURSOR);
      },
      onScaleTimeAxis: (dx) => {
        const factor = Math.exp(-dx * 0.008);
        this.timeScale.zoomAtCoordinate(this.layout.plotWidth * 0.5, factor, this.plotList.firstIndex());
        this.scheduler.invalidate(DirtyFlag.FULL | DirtyFlag.CURSOR);
      },
      onFitContent: () => {
        this.fitContent();
      },
      onDragDivider: (divIdx, dy) => {
        this.resizeDivider(divIdx, dy);
      },
      onHoverDivider: (divIdx) => {
        if (this.hoveredDividerIndex !== divIdx) {
          this.hoveredDividerIndex = divIdx;
          this.scheduler.invalidate(DirtyFlag.CURSOR);
        }
      },
      onCrosshairMove: (x, y, paneId) => {
        const barIndex =
          this.plotList.length > 0
            ? Math.max(
                this.plotList.firstIndex(),
                Math.min(this.plotList.lastIndex(), this.timeScale.coordinateToLogical(x)),
              )
            : null;
        const scale = paneId === 'main' ? this.mainPriceScale : this.subPanes.get(paneId)?.priceScale;
        const price = scale ? scale.coordinateToPrice(y) : null;
        this.crosshair = { visible: true, x, y, paneId, barIndex, price };
        this.emitCrosshair();
        this.scheduler.invalidate(DirtyFlag.CURSOR);
      },
      onCrosshairLeave: () => {
        if (this.crosshair.visible) {
          this.crosshair = { ...this.crosshair, visible: false };
          this.emitCrosshair();
          this.scheduler.invalidate(DirtyFlag.CURSOR);
        }
      },
      onInterceptPointerDown: (x, y, paneId) => this.pointerInterceptor?.onDown(x, y, paneId) ?? false,
      onInterceptPointerMove: (x, y) => this.pointerInterceptor?.onMove(x, y) ?? false,
      onInterceptPointerUp: () => this.pointerInterceptor?.onUp() ?? false,
    });

    this.scheduler.invalidate(DirtyFlag.FULL | DirtyFlag.CURSOR);
  }

  unmount(): void {
    this.gestures?.dispose();
    this.gestures = null;
    this.canvasPair?.dispose();
    this.canvasPair = null;
  }

  destroy(): void {
    this.scheduler.dispose();
    this.unmount();
    this.crosshairListeners.clear();
    this.loadMoreListeners.clear();
  }

  setSymbolInfo(symbol: SymbolInfo, resolution?: Resolution): void {
    this.symbol = symbol;
    if (resolution) this.resolution = resolution;
    this.mainPriceScale.updateConfig({
      tickSize: symbol.tickSize,
      precision: symbol.precision,
      ...(symbol.symlogLinthresh !== undefined ? { symlogLinthresh: symbol.symlogLinthresh } : {}),
    });
    this.mainPriceScale.setAutoScale(true);
    this.scheduler.invalidate(DirtyFlag.FULL | DirtyFlag.CURSOR);
  }

  setBars(bars: readonly OHLCVBar[], fitLastBars = 140): void {
    this.plotList.setBars(bars);
    this.loadMorePending = false;
    if (this.plotList.length > 0) {
      const last = this.plotList.lastIndex();
      this.timeScale.setBaseIndex(last);
      const start = Math.max(this.plotList.firstIndex(), last - fitLastBars + 1);
      this.timeScale.fitContent(start, last, 8);
      this.mainPriceScale.setAutoScale(true);
    }
    this.scheduler.invalidate(DirtyFlag.FULL | DirtyFlag.CURSOR);
  }

  prependBars(olderBars: readonly OHLCVBar[]): void {
    this.plotList.prependBars(olderBars);
    this.loadMorePending = false;
    this.scheduler.invalidate(DirtyFlag.FULL | DirtyFlag.CURSOR);
  }

  upsertBar(bar: OHLCVBar, allowDuplicateTimestamp = false): void {
    const { appended, barIndex } = this.plotList.upsertBar(bar, allowDuplicateTimestamp);
    if (appended) {
      this.timeScale.setBaseIndex(barIndex);
    }
    this.scheduler.invalidate(DirtyFlag.FULL | DirtyFlag.CURSOR);
  }

  setChartStyle(style: ChartStyle): void {
    this.chartStyle = style;
    this.scheduler.invalidate(DirtyFlag.FULL | DirtyFlag.CURSOR);
  }

  setPriceScaleMode(mode: PriceScaleMode): void {
    this.mainPriceScale.setMode(mode);
    this.mainPriceScale.setAutoScale(true);
    this.scheduler.invalidate(DirtyFlag.FULL | DirtyFlag.CURSOR);
  }

  setInverted(inverted: boolean): void {
    this.mainPriceScale.setInverted(inverted);
    this.scheduler.invalidate(DirtyFlag.FULL | DirtyFlag.CURSOR);
  }

  setTheme(theme: 'dark' | 'light'): void {
    this.theme = theme === 'light' ? LIGHT_THEME : DARK_THEME;
    this.scheduler.invalidate(DirtyFlag.FULL | DirtyFlag.CURSOR);
  }

  setShowVolume(show: boolean): void {
    this.showVolume = show;
    this.scheduler.invalidate(DirtyFlag.FULL);
  }

  fitContent(): void {
    if (this.plotList.length === 0) return;
    this.timeScale.fitContent(this.plotList.firstIndex(), this.plotList.lastIndex(), 8);
    this.mainPriceScale.setAutoScale(true);
    this.scheduler.invalidate(DirtyFlag.FULL | DirtyFlag.CURSOR);
  }

  resetView(): void {
    if (this.plotList.length === 0) return;
    const last = this.plotList.lastIndex();
    const start = Math.max(this.plotList.firstIndex(), last - 139);
    this.timeScale.fitContent(start, last, 8);
    this.mainPriceScale.setAutoScale(true);
    this.scheduler.invalidate(DirtyFlag.FULL | DirtyFlag.CURSOR);
  }

  setMainOverlays(overlays: MainOverlayPlot[]): void {
    this.mainOverlays = overlays;
    this.scheduler.invalidate(DirtyFlag.FULL);
  }

  addSubPane(id: string, weight = 0.28, precision = 2): void {
    if (this.subPanes.has(id)) return;
    this.paneSpecs.push({ id, weight, minHeightPx: 72 });
    this.subPanes.set(id, {
      priceScale: new SymlogPriceScale({ mode: 'linear', tickSize: 0.01, precision }),
      plots: [],
    });
    if (this.canvasPair) {
      this.recomputeLayout(this.canvasPair.metrics.mediaWidth, this.canvasPair.metrics.mediaHeight);
    }
    this.scheduler.invalidate(DirtyFlag.FULL | DirtyFlag.CURSOR);
  }

  setSubPanePlots(paneId: string, plots: SubPaneSeriesPlot[], fixedRange?: [number, number]): void {
    const sub = this.subPanes.get(paneId);
    if (!sub) return;
    sub.plots = plots;
    if (fixedRange) {
      sub.priceScale.setAutoScale(true);
      sub.priceScale.updateAutoRange(fixedRange[0], fixedRange[1]);
      sub.priceScale.setAutoScale(false);
    }
    this.scheduler.invalidate(DirtyFlag.FULL | DirtyFlag.CURSOR);
  }

  removeSubPane(id: string): void {
    if (id === 'main') return;
    const idx = this.paneSpecs.findIndex((p) => p.id === id);
    if (idx !== -1) this.paneSpecs.splice(idx, 1);
    this.subPanes.delete(id);
    if (this.canvasPair) {
      this.recomputeLayout(this.canvasPair.metrics.mediaWidth, this.canvasPair.metrics.mediaHeight);
    }
    this.scheduler.invalidate(DirtyFlag.FULL | DirtyFlag.CURSOR);
  }

  exportSnapshotDataUrl(): string | null {
    return this.canvasPair ? this.canvasPair.exportSnapshotDataUrl() : null;
  }

  getTelemetry(): FrameTelemetry {
    return { ...this.lastTelemetry };
  }

  subscribeCrosshair(fn: (state: CrosshairState) => void): () => void {
    this.crosshairListeners.add(fn);
    return () => this.crosshairListeners.delete(fn);
  }

  onLoadMoreHistory(fn: (beforeTime: number) => void): () => void {
    this.loadMoreListeners.add(fn);
    return () => this.loadMoreListeners.delete(fn);
  }

  setOverlayRenderers(
    onBase: ((ctx: CanvasRenderingContext2D) => void) | undefined,
    onTop: ((ctx: CanvasRenderingContext2D) => void) | undefined,
  ): void {
    this.onBaseOverlay = onBase;
    this.onTopOverlay = onTop;
    this.scheduler.invalidate(DirtyFlag.FULL | DirtyFlag.CURSOR);
  }

  setPointerInterceptor(
    interceptor: {
      onDown: (x: number, y: number, paneId: string) => boolean;
      onMove: (x: number, y: number) => boolean;
      onUp: () => boolean;
    } | null,
  ): void {
    this.pointerInterceptor = interceptor;
  }

  requestRedraw(full = true): void {
    this.scheduler.invalidate(full ? DirtyFlag.FULL | DirtyFlag.CURSOR : DirtyFlag.CURSOR);
  }

  /**
   * Synchronize crosshair time from a sibling chart tile across different timeframes!
   * Updates topCanvas ONLY (zero baseCanvas redraw).
   */
  setExternalCrosshairTime(timeMs: number | null): void {
    if (timeMs === null || this.plotList.length === 0) {
      if (this.crosshair.visible) {
        this.crosshair = { ...this.crosshair, visible: false };
        this.scheduler.invalidate(DirtyFlag.CURSOR);
      }
      return;
    }
    const barIndex = this.plotList.findIndexByTime(timeMs);
    const x = this.timeScale.indexToCoordinate(barIndex);
    const bar = this.plotList.getBar(barIndex);
    const y = bar ? this.mainPriceScale.priceToCoordinate(bar.close) : -10;
    this.crosshair = { visible: true, x, y, paneId: 'main', barIndex, price: bar?.close ?? null };
    this.scheduler.invalidate(DirtyFlag.CURSOR);
  }

  getBarTimeAt(barIndex: number): number | null {
    return this.plotList.getBar(barIndex)?.time ?? null;
  }

  getMainCoordBridge() {
    const m = this.canvasPair?.metrics ?? {
      horizontalPixelRatio: 1,
      verticalPixelRatio: 1,
    };
    const mainPane = this.layout.panes[0]?.rect ?? { x: 0, y: 0, width: 800, height: 400 };
    return {
      paneRect: mainPane,
      horizontalPixelRatio: m.horizontalPixelRatio,
      verticalPixelRatio: m.verticalPixelRatio,
      indexToX: (idx: number) => this.timeScale.indexToCoordinate(idx),
      xToIndex: (x: number) => this.timeScale.coordinateToIndex(x),
      priceToY: (p: number) => this.mainPriceScale.priceToCoordinate(p),
      yToPrice: (y: number) => this.mainPriceScale.coordinateToPrice(y),
      timeToIndex: (t: number) => this.plotList.findIndexByTime(t),
      indexToTime: (idx: number) => this.plotList.getBar(idx)?.time ?? null,
      getBar: (idx: number) => this.plotList.getBar(idx),
      firstBarIndex: () => this.plotList.firstIndex(),
      lastBarIndex: () => this.plotList.lastIndex(),
      formatPrice: (p: number) => this.mainPriceScale.formatPrice(p),
    };
  }

  private emitCrosshair(): void {
    for (const fn of this.crosshairListeners) {
      fn(this.crosshair);
    }
  }

  private checkLoadMoreHistory(): void {
    if (this.loadMorePending || this.plotList.length === 0 || this.loadMoreListeners.size === 0) return;
    const vis = this.timeScale.getVisibleLogicalRange(this.plotList.firstIndex(), this.plotList.lastIndex());
    if (vis.rawFrom <= this.plotList.firstIndex() + 25) {
      const oldest = this.plotList.getBar(this.plotList.firstIndex());
      if (oldest) {
        this.loadMorePending = true;
        for (const fn of this.loadMoreListeners) fn(oldest.time);
      }
    }
  }

  private recomputeLayout(mediaWidth: number, mediaHeight: number): void {
    this.layout = this.layoutSolver.solve(mediaWidth, mediaHeight, this.paneSpecs);
    this.timeScale.setWidth(this.layout.plotWidth);
    const mainPane = this.layout.panes[0];
    if (mainPane) {
      this.mainPriceScale.setViewport(mainPane.rect.y, mainPane.rect.height);
    }
    for (let i = 1; i < this.layout.panes.length; i++) {
      const p = this.layout.panes[i]!;
      this.subPanes.get(p.id)?.priceScale.setViewport(p.rect.y, p.rect.height);
    }
  }

  private resizeDivider(divIdx: number, dy: number): void {
    const above = this.paneSpecs[divIdx];
    const below = this.paneSpecs[divIdx + 1];
    if (!above || !below || this.layout.plotHeight <= 0) return;
    const totalWeight = this.paneSpecs.reduce((acc, p) => acc + p.weight, 0);
    const deltaW = (dy / this.layout.plotHeight) * totalWeight;
    const minW = 0.08 * totalWeight;
    if (above.weight + deltaW < minW || below.weight - deltaW < minW) return;
    above.weight += deltaW;
    below.weight -= deltaW;
    if (this.canvasPair) {
      this.recomputeLayout(this.canvasPair.metrics.mediaWidth, this.canvasPair.metrics.mediaHeight);
    }
    this.scheduler.invalidate(DirtyFlag.FULL | DirtyFlag.CURSOR);
  }

  private renderFrame(mask: number): void {
    if (!this.canvasPair) return;
    const t0 = performance.now();

    if ((mask & (DirtyFlag.FULL | DirtyFlag.LIGHT)) !== 0) {
      // Auto-scale visible price range
      if (this.plotList.length > 0) {
        const vis = this.timeScale.getVisibleLogicalRange(
          this.plotList.firstIndex(),
          this.plotList.lastIndex(),
        );
        const useHA = this.chartStyle === 'heikin_ashi';
        const bounds = this.plotList.getPriceBounds(vis.from, vis.to, this.timeScale.barSpacing, useHA);
        const firstVisBar = this.plotList.getBar(vis.from);
        if (firstVisBar) {
          this.mainPriceScale.setBasePrice(firstVisBar.close);
        }
        if (bounds) {
          this.mainPriceScale.updateAutoRange(bounds.minPrice, bounds.maxPrice);
        }

        // Auto-scale sub-panes
        for (const sub of this.subPanes.values()) {
          if (!sub.priceScale.autoScale) continue;
          let minV = Infinity;
          let maxV = -Infinity;
          for (const plot of sub.plots) {
            const start = Math.max(vis.from, plot.startBarIndex);
            const end = Math.min(vis.to, plot.startBarIndex + plot.values.length - 1);
            for (let idx = start; idx <= end; idx++) {
              const v = plot.values[idx - plot.startBarIndex]!;
              if (Number.isNaN(v)) continue;
              if (v < minV) minV = v;
              if (v > maxV) maxV = v;
            }
          }
          if (Number.isFinite(minV) && Number.isFinite(maxV)) {
            sub.priceScale.updateAutoRange(minV, maxV);
          }
        }
      }

      const res = renderBaseLayer({
        ctx: this.canvasPair.baseCtx,
        metrics: this.canvasPair.metrics,
        layout: this.layout,
        theme: this.theme,
        symbol: this.symbol,
        resolution: this.resolution,
        chartStyle: this.chartStyle,
        showVolume: this.showVolume,
        showSessionBreaks: this.showSessionBreaks,
        plotList: this.plotList,
        timeScale: this.timeScale,
        mainPriceScale: this.mainPriceScale,
        calendar: this.calendar,
        mainOverlays: this.mainOverlays,
        subPanes: this.subPanes,
        ...(this.onBaseOverlay ? { onMainPaneBaseOverlay: this.onBaseOverlay } : {}),
      });

      const dt = performance.now() - t0;
      this.frameHistoryMs.push(dt);
      if (this.frameHistoryMs.length > 60) this.frameHistoryMs.shift();
      const sorted = [...this.frameHistoryMs].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)] ?? dt;

      this.lastTelemetry = {
        lastFrameMs: Number(dt.toFixed(2)),
        medianFrameMs: Number(median.toFixed(2)),
        drawnBars: res.drawnBars,
        totalBars: this.plotList.length,
        mipmapStride: res.mipmapStride,
        dpr: Number(this.canvasPair.metrics.horizontalPixelRatio.toFixed(2)),
      };
    }

    if ((mask & (DirtyFlag.CURSOR | DirtyFlag.FULL | DirtyFlag.LIGHT)) !== 0) {
      renderTopLayer({
        ctx: this.canvasPair.topCtx,
        metrics: this.canvasPair.metrics,
        layout: this.layout,
        theme: this.theme,
        symbol: this.symbol,
        resolution: this.resolution,
        plotList: this.plotList,
        timeScale: this.timeScale,
        mainPriceScale: this.mainPriceScale,
        subPanes: this.subPanes,
        crosshair: this.crosshair,
        hoveredDividerIndex: this.hoveredDividerIndex,
        ...(this.onTopOverlay ? { onMainPaneTopOverlay: this.onTopOverlay } : {}),
      });
    }
  }
}
