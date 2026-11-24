import type { TileLayout } from '../canvas/tile-canvas-pair.ts';

export interface GestureCallbacks {
  getLayout: () => TileLayout;
  onPan: (dx: number, dy: number, paneId: string) => void;
  onZoomX: (anchorX: number, scaleFactor: number) => void;
  onScalePriceAxis: (paneId: string, dy: number) => void;
  onResetPriceAxis: (paneId: string) => void;
  onScaleTimeAxis: (dx: number) => void;
  onFitContent: () => void;
  onDragDivider: (dividerIndex: number, dy: number) => void;
  onHoverDivider: (dividerIndex: number | null) => void;
  onCrosshairMove: (x: number, y: number, paneId: string) => void;
  onCrosshairLeave: () => void;
  onInterceptPointerDown?: (x: number, y: number, paneId: string) => boolean;
  onInterceptPointerMove?: (x: number, y: number) => boolean;
  onInterceptPointerUp?: () => boolean;
}

type DragMode =
  | { kind: 'none' }
  | { kind: 'pan'; paneId: string; lastX: number; lastY: number; vx: number; lastTs: number }
  | { kind: 'price_axis'; paneId: string; lastY: number }
  | { kind: 'time_axis'; lastX: number }
  | { kind: 'divider'; dividerIndex: number; lastY: number };

const DIVIDER_HIT_RADIUS = 5;

/**
 * High-precision pointer/wheel/touch gesture state machine with kinetic pan inertia,
 * cursor-anchored wheel & pinch zoom, axis drag scaling, and multi-pane divider resize.
 */
export class GestureController {
  private drag: DragMode = { kind: 'none' };
  private inertiaRaf: number | null = null;
  private inertiaVx = 0;
  private activePointers = new Map<number, { x: number; y: number }>();
  private lastPinchDist: number | null = null;

  constructor(
    private readonly el: HTMLElement,
    private readonly cb: GestureCallbacks,
  ) {
    this.el.addEventListener('pointerdown', this.handlePointerDown);
    window.addEventListener('pointermove', this.handlePointerMove);
    window.addEventListener('pointerup', this.handlePointerUp);
    window.addEventListener('pointercancel', this.handlePointerUp);
    this.el.addEventListener('pointerleave', this.handlePointerLeave);
    this.el.addEventListener('wheel', this.handleWheel, { passive: false });
    this.el.addEventListener('dblclick', this.handleDoubleClick);
  }

  private getLocalCoords(ev: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = this.el.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  private hitDivider(y: number, layout: TileLayout): number | null {
    for (const d of layout.dividers) {
      if (Math.abs(y - d.y) <= DIVIDER_HIT_RADIUS) return d.index;
    }
    return null;
  }

  private hitPaneId(y: number, layout: TileLayout): string {
    for (const p of layout.panes) {
      if (y >= p.rect.y && y <= p.rect.y + p.rect.height) return p.id;
    }
    return layout.panes[0]?.id ?? 'main';
  }

  private stopInertia(): void {
    if (this.inertiaRaf !== null) {
      cancelAnimationFrame(this.inertiaRaf);
      this.inertiaRaf = null;
    }
    this.inertiaVx = 0;
  }

  private startInertia(initialVxPxPerMs: number, paneId: string): void {
    this.stopInertia();
    if (Math.abs(initialVxPxPerMs) < 0.08) return;
    this.inertiaVx = Math.max(-4.5, Math.min(4.5, initialVxPxPerMs));
    let lastTime = performance.now();

    const step = (now: number) => {
      const dt = Math.min(32, Math.max(1, now - lastTime));
      lastTime = now;
      this.cb.onPan(this.inertiaVx * dt, 0, paneId);
      // Smooth exponential friction matching TradingView glide feel
      this.inertiaVx *= Math.pow(0.92, dt / 16.67);
      if (Math.abs(this.inertiaVx) > 0.02) {
        this.inertiaRaf = requestAnimationFrame(step);
      } else {
        this.inertiaRaf = null;
      }
    };
    this.inertiaRaf = requestAnimationFrame(step);
  }

  private handlePointerDown = (ev: PointerEvent): void => {
    if (ev.button !== 0 && ev.pointerType === 'mouse') return;
    this.stopInertia();
    const { x, y } = this.getLocalCoords(ev);
    this.activePointers.set(ev.pointerId, { x, y });

    if (this.activePointers.size === 2) {
      const pts = [...this.activePointers.values()];
      this.lastPinchDist = Math.hypot(pts[1]!.x - pts[0]!.x, pts[1]!.y - pts[0]!.y);
      this.drag = { kind: 'none' };
      return;
    }

    const layout = this.cb.getLayout();
    const divIdx = this.hitDivider(y, layout);
    if (divIdx !== null) {
      this.drag = { kind: 'divider', dividerIndex: divIdx, lastY: y };
      this.el.setPointerCapture?.(ev.pointerId);
      return;
    }

    if (x >= layout.plotWidth && y < layout.plotHeight) {
      this.drag = { kind: 'price_axis', paneId: this.hitPaneId(y, layout), lastY: y };
      this.el.setPointerCapture?.(ev.pointerId);
      return;
    }

    if (y >= layout.plotHeight && x < layout.plotWidth) {
      this.drag = { kind: 'time_axis', lastX: x };
      this.el.setPointerCapture?.(ev.pointerId);
      return;
    }

    if (x < layout.plotWidth && y < layout.plotHeight) {
      const paneId = this.hitPaneId(y, layout);
      if (this.cb.onInterceptPointerDown?.(x, y, paneId)) {
        this.el.setPointerCapture?.(ev.pointerId);
        return;
      }
      this.drag = {
        kind: 'pan',
        paneId,
        lastX: x,
        lastY: y,
        vx: 0,
        lastTs: performance.now(),
      };
      this.el.style.cursor = 'grabbing';
      this.el.setPointerCapture?.(ev.pointerId);
    }
  };

  private handlePointerMove = (ev: PointerEvent): void => {
    const { x, y } = this.getLocalCoords(ev);
    if (this.activePointers.has(ev.pointerId)) {
      this.activePointers.set(ev.pointerId, { x, y });
    }

    // Two-finger pinch zoom
    if (this.activePointers.size === 2 && this.lastPinchDist !== null) {
      const pts = [...this.activePointers.values()];
      const dist = Math.hypot(pts[1]!.x - pts[0]!.x, pts[1]!.y - pts[0]!.y);
      if (this.lastPinchDist > 5 && dist > 5) {
        const midX = (pts[0]!.x + pts[1]!.x) * 0.5;
        this.cb.onZoomX(midX, dist / this.lastPinchDist);
        this.lastPinchDist = dist;
      }
      return;
    }

    if (this.drag.kind === 'pan') {
      const dx = x - this.drag.lastX;
      const dy = y - this.drag.lastY;
      const now = performance.now();
      const dt = Math.max(1, now - this.drag.lastTs);
      this.drag.vx = this.drag.vx * 0.4 + (dx / dt) * 0.6;
      this.drag.lastX = x;
      this.drag.lastY = y;
      this.drag.lastTs = now;
      this.cb.onPan(dx, dy, this.drag.paneId);
      this.cb.onCrosshairMove(x, y, this.drag.paneId);
      return;
    }

    if (this.drag.kind === 'price_axis') {
      const dy = y - this.drag.lastY;
      this.drag.lastY = y;
      this.cb.onScalePriceAxis(this.drag.paneId, dy);
      return;
    }

    if (this.drag.kind === 'time_axis') {
      const dx = x - this.drag.lastX;
      this.drag.lastX = x;
      this.cb.onScaleTimeAxis(dx);
      return;
    }

    if (this.drag.kind === 'divider') {
      const dy = y - this.drag.lastY;
      this.drag.lastY = y;
      this.cb.onDragDivider(this.drag.dividerIndex, dy);
      return;
    }

    if (this.cb.onInterceptPointerMove?.(x, y)) {
      const layout = this.cb.getLayout();
      this.cb.onCrosshairMove(x, y, this.hitPaneId(y, layout));
      return;
    }

    // Idle hover: cursor feedback & lightweight topCanvas crosshair update
    const layout = this.cb.getLayout();
    const inside = x >= 0 && y >= 0 && x <= layout.totalWidth && y <= layout.totalHeight;
    if (!inside) return;

    const divIdx = this.hitDivider(y, layout);
    this.cb.onHoverDivider(divIdx);
    if (divIdx !== null) {
      this.el.style.cursor = 'row-resize';
      return;
    }

    if (x >= layout.plotWidth && y < layout.plotHeight) {
      this.el.style.cursor = 'ns-resize';
      this.cb.onCrosshairLeave();
      return;
    }
    if (y >= layout.plotHeight && x < layout.plotWidth) {
      this.el.style.cursor = 'ew-resize';
      this.cb.onCrosshairLeave();
      return;
    }

    this.el.style.cursor = 'crosshair';
    this.cb.onCrosshairMove(x, y, this.hitPaneId(y, layout));
  };

  private handlePointerUp = (ev: PointerEvent): void => {
    this.activePointers.delete(ev.pointerId);
    if (this.activePointers.size < 2) {
      this.lastPinchDist = null;
    }
    if (this.cb.onInterceptPointerUp?.()) {
      return;
    }
    if (this.drag.kind === 'pan') {
      const paneId = this.drag.paneId;
      const vx = performance.now() - this.drag.lastTs < 65 ? this.drag.vx : 0;
      this.drag = { kind: 'none' };
      this.el.style.cursor = 'crosshair';
      this.startInertia(vx, paneId);
      return;
    }
    if (this.drag.kind !== 'none') {
      this.drag = { kind: 'none' };
      this.el.style.cursor = 'crosshair';
    }
  };

  private handlePointerLeave = (): void => {
    if (this.drag.kind === 'none') {
      this.cb.onHoverDivider(null);
      this.cb.onCrosshairLeave();
    }
  };

  private handleWheel = (ev: WheelEvent): void => {
    ev.preventDefault();
    this.stopInertia();
    const { x } = this.getLocalCoords(ev);
    const layout = this.cb.getLayout();

    // Trackpad horizontal scroll pans smoothly; vertical scroll zooms anchored at cursor
    if (Math.abs(ev.deltaX) > Math.abs(ev.deltaY) * 1.2 && !ev.ctrlKey) {
      this.cb.onPan(-ev.deltaX, 0, 'main');
      return;
    }

    const delta = ev.deltaY;
    const zoomFactor = Math.exp(-delta * 0.0014);
    this.cb.onZoomX(Math.min(x, layout.plotWidth), zoomFactor);
  };

  private handleDoubleClick = (ev: MouseEvent): void => {
    const { x, y } = this.getLocalCoords(ev);
    const layout = this.cb.getLayout();
    if (x >= layout.plotWidth && y < layout.plotHeight) {
      this.cb.onResetPriceAxis(this.hitPaneId(y, layout));
      return;
    }
    if (y >= layout.plotHeight && x < layout.plotWidth) {
      this.cb.onFitContent();
    }
  };

  dispose(): void {
    this.stopInertia();
    this.el.removeEventListener('pointerdown', this.handlePointerDown);
    window.removeEventListener('pointermove', this.handlePointerMove);
    window.removeEventListener('pointerup', this.handlePointerUp);
    window.removeEventListener('pointercancel', this.handlePointerUp);
    this.el.removeEventListener('pointerleave', this.handlePointerLeave);
    this.el.removeEventListener('wheel', this.handleWheel);
    this.el.removeEventListener('dblclick', this.handleDoubleClick);
  }
}
