export const enum DirtyFlag {
  NONE = 0,
  CURSOR = 1 << 0,
  LIGHT = 1 << 1,
  FULL = 1 << 2,
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PaneSpec {
  id: string;
  weight: number;
  minHeightPx: number;
}

export interface TileLayout {
  totalWidth: number;
  totalHeight: number;
  rightAxisWidth: number;
  timeAxisHeight: number;
  plotWidth: number;
  plotHeight: number;
  panes: Array<{ id: string; rect: Rect; priceAxisRect: Rect }>;
  dividers: Array<{ index: number; y: number; aboveId: string; belowId: string }>;
  timeAxisRect: Rect;
  cornerRect: Rect;
}

/**
 * Pure-math viewport divider: computes scissor-clipped pane rectangles, price axis gutters,
 * bottom time axis, and draggable horizontal divider coordinates inside a single 2-canvas tile.
 */
export class PaneLayoutSolver {
  solve(
    totalWidth: number,
    totalHeight: number,
    panes: readonly PaneSpec[],
    rightAxisWidth = 74,
    timeAxisHeight = 28,
  ): TileLayout {
    const w = Math.max(120, totalWidth);
    const h = Math.max(80, totalHeight);
    const plotWidth = Math.max(40, w - rightAxisWidth);
    const plotHeight = Math.max(40, h - timeAxisHeight);

    const activePanes = panes.length > 0 ? panes : [{ id: 'main', weight: 1, minHeightPx: 60 }];
    const totalWeight = activePanes.reduce((acc, p) => acc + Math.max(0.05, p.weight), 0);

    const resolvedPanes: TileLayout['panes'] = [];
    const dividers: TileLayout['dividers'] = [];

    let cursorY = 0;
    for (let i = 0; i < activePanes.length; i++) {
      const spec = activePanes[i]!;
      const isLast = i === activePanes.length - 1;
      const rawH = isLast
        ? Math.max(30, plotHeight - cursorY)
        : Math.max(spec.minHeightPx, Math.round((spec.weight / totalWeight) * plotHeight));
      const height = isLast ? Math.max(20, plotHeight - cursorY) : Math.min(rawH, plotHeight - cursorY - 30);

      resolvedPanes.push({
        id: spec.id,
        rect: { x: 0, y: cursorY, width: plotWidth, height },
        priceAxisRect: { x: plotWidth, y: cursorY, width: rightAxisWidth, height },
      });

      cursorY += height;
      if (!isLast) {
        const nextSpec = activePanes[i + 1]!;
        dividers.push({
          index: i,
          y: cursorY,
          aboveId: spec.id,
          belowId: nextSpec.id,
        });
      }
    }

    return {
      totalWidth: w,
      totalHeight: h,
      rightAxisWidth,
      timeAxisHeight,
      plotWidth,
      plotHeight,
      panes: resolvedPanes,
      dividers,
      timeAxisRect: { x: 0, y: plotHeight, width: plotWidth, height: timeAxisHeight },
      cornerRect: { x: plotWidth, y: plotHeight, width: rightAxisWidth, height: timeAxisHeight },
    };
  }
}

/**
 * Physical bitmap coordinate helpers guaranteeing razor-sharp 1px hairlines and
 * dead-center candle wicks at 100%, 125%, 150%, and 200% DPI scaling!
 */
export function snapHairline(cssCoord: number, pixelRatio: number, physStrokeWidth = 1): number {
  const scaled = cssCoord * pixelRatio;
  return physStrokeWidth % 2 === 1 ? Math.floor(scaled) + 0.5 : Math.round(scaled);
}

export interface CandleBitmapMetrics {
  wickCenterPx: number;
  wickWidthPx: number;
  bodyLeftPx: number;
  bodyWidthPx: number;
}

/**
 * Computes physical pixel coordinates for a candlestick body + wick such that:
 *   (bodyWidthPx & 1) === (wickWidthPx & 1)
 * ensuring the wick sits mathematically centered inside every candle body at ANY DPI ratio!
 */
export function computeCandleBitmapMetrics(
  centerCssX: number,
  barSpacingCss: number,
  pixelRatio: number,
): CandleBitmapMetrics {
  const wickWidthPx = Math.max(1, Math.round(pixelRatio));
  const rawBodyPx = Math.max(1, Math.floor(barSpacingCss * 0.72 * pixelRatio));
  // Match parity with wickWidthPx so (bodyWidthPx - wickWidthPx) is strictly even
  let bodyWidthPx = rawBodyPx;
  if (bodyWidthPx > 1 && (bodyWidthPx & 1) !== (wickWidthPx & 1)) {
    bodyWidthPx = Math.max(1, bodyWidthPx - 1);
  }
  const centerPx = Math.round(centerCssX * pixelRatio);
  const bodyLeftPx = centerPx - Math.floor(bodyWidthPx / 2);
  const wickCenterPx = bodyLeftPx + bodyWidthPx / 2;

  return { wickCenterPx, wickWidthPx, bodyLeftPx, bodyWidthPx };
}

export interface CanvasMetrics {
  mediaWidth: number;
  mediaHeight: number;
  bitmapWidth: number;
  bitmapHeight: number;
  horizontalPixelRatio: number;
  verticalPixelRatio: number;
}

/**
 * Coalesced requestAnimationFrame scheduler with dirty-bitmask batching.
 * Rapid ticks or pointer moves inside a single frame coalesce into ONE render pass.
 */
export class DirtyScheduler {
  private dirtyMask = DirtyFlag.NONE;
  private rafId: number | null = null;
  private disposed = false;

  private readonly onFrame: (mask: number) => void;

  constructor(onFrame: (mask: number) => void) {
    this.onFrame = onFrame;
  }

  invalidate(flag: DirtyFlag): void {
    if (this.disposed) return;
    this.dirtyMask |= flag;
    if (this.rafId === null) {
      this.rafId = requestAnimationFrame(() => {
        this.rafId = null;
        const mask = this.dirtyMask;
        this.dirtyMask = DirtyFlag.NONE;
        if (mask !== DirtyFlag.NONE && !this.disposed) {
          this.onFrame(mask);
        }
      });
    }
  }

  flushSync(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    const mask = this.dirtyMask;
    this.dirtyMask = DirtyFlag.NONE;
    if (mask !== DirtyFlag.NONE && !this.disposed) {
      this.onFrame(mask);
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }
}

/**
 * Manages exactly TWO stacked HTML5 Canvas 2D surfaces per Chart Tile:
 * - baseCanvas: background, grid, candles, indicators, committed drawings, static axes
 * - topCanvas: 120 FPS crosshair, live floating axis badges, active drag handles
 * Sized via ResizeObserver devicePixelContentBoxSize for zero-blur HiDPI rendering.
 */
export class TileCanvasPair {
  readonly baseCanvas: HTMLCanvasElement;
  readonly topCanvas: HTMLCanvasElement;
  readonly baseCtx: CanvasRenderingContext2D;
  readonly topCtx: CanvasRenderingContext2D;

  private observer: ResizeObserver;
  private _metrics: CanvasMetrics = {
    mediaWidth: 800,
    mediaHeight: 500,
    bitmapWidth: 800,
    bitmapHeight: 500,
    horizontalPixelRatio: 1,
    verticalPixelRatio: 1,
  };

  private readonly container: HTMLElement;
  private readonly onResize: (metrics: CanvasMetrics) => void;

  constructor(container: HTMLElement, onResize: (metrics: CanvasMetrics) => void) {
    this.container = container;
    this.onResize = onResize;
    container.style.position = container.style.position || 'relative';
    container.style.overflow = 'hidden';
    container.style.userSelect = 'none';
    container.style.touchAction = 'none';

    this.baseCanvas = document.createElement('canvas');
    this.topCanvas = document.createElement('canvas');

    for (const c of [this.baseCanvas, this.topCanvas]) {
      c.style.position = 'absolute';
      c.style.inset = '0';
      c.style.width = '100%';
      c.style.height = '100%';
      c.style.display = 'block';
    }
    this.topCanvas.style.pointerEvents = 'none';

    container.appendChild(this.baseCanvas);
    container.appendChild(this.topCanvas);

    const bCtx = this.baseCanvas.getContext('2d', { alpha: false });
    const tCtx = this.topCanvas.getContext('2d', { alpha: true });
    if (!bCtx || !tCtx) {
      throw new Error('Failed to acquire 2D canvas context');
    }
    this.baseCtx = bCtx;
    this.topCtx = tCtx;

    this.observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      this.applyResize(entry);
    });

    try {
      this.observer.observe(container, { box: 'device-pixel-content-box' });
    } catch {
      this.observer.observe(container);
    }

    // Immediate initial sizing
    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.setSize(
      Math.max(1, Math.floor(rect.width || 800)),
      Math.max(1, Math.floor(rect.height || 500)),
      Math.max(1, Math.round((rect.width || 800) * dpr)),
      Math.max(1, Math.round((rect.height || 500) * dpr)),
    );
  }

  get metrics(): CanvasMetrics {
    return this._metrics;
  }

  private applyResize(entry: ResizeObserverEntry): void {
    const cssW = Math.max(1, entry.contentRect.width);
    const cssH = Math.max(1, entry.contentRect.height);
    const dpr = window.devicePixelRatio || 1;

    const dpBox = (entry as ResizeObserverEntry & {
      devicePixelContentBoxSize?: ReadonlyArray<{ inlineSize: number; blockSize: number }>;
    }).devicePixelContentBoxSize?.[0];

    const bmpW = dpBox ? Math.max(1, Math.round(dpBox.inlineSize)) : Math.max(1, Math.round(cssW * dpr));
    const bmpH = dpBox ? Math.max(1, Math.round(dpBox.blockSize)) : Math.max(1, Math.round(cssH * dpr));

    this.setSize(cssW, cssH, bmpW, bmpH);
  }

  private setSize(mediaWidth: number, mediaHeight: number, bitmapWidth: number, bitmapHeight: number): void {
    if (
      this._metrics.bitmapWidth === bitmapWidth &&
      this._metrics.bitmapHeight === bitmapHeight &&
      this._metrics.mediaWidth === mediaWidth &&
      this._metrics.mediaHeight === mediaHeight
    ) {
      return;
    }

    this.baseCanvas.width = bitmapWidth;
    this.baseCanvas.height = bitmapHeight;
    this.topCanvas.width = bitmapWidth;
    this.topCanvas.height = bitmapHeight;

    this._metrics = {
      mediaWidth,
      mediaHeight,
      bitmapWidth,
      bitmapHeight,
      horizontalPixelRatio: bitmapWidth / mediaWidth,
      verticalPixelRatio: bitmapHeight / mediaHeight,
    };

    this.onResize(this._metrics);
  }

  exportSnapshotDataUrl(): string {
    const composite = document.createElement('canvas');
    composite.width = this._metrics.bitmapWidth;
    composite.height = this._metrics.bitmapHeight;
    const ctx = composite.getContext('2d');
    if (!ctx) return this.baseCanvas.toDataURL('image/png');
    ctx.drawImage(this.baseCanvas, 0, 0);
    ctx.drawImage(this.topCanvas, 0, 0);
    return composite.toDataURL('image/png');
  }

  dispose(): void {
    this.observer.disconnect();
    this.baseCanvas.remove();
    this.topCanvas.remove();
  }
}
