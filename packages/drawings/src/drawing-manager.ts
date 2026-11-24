import type { DrawingEntity, LogicalAnchor, OHLCVBar } from '@openview/protocol';
import {
  distancePointToCircleBorder,
  distancePointToLineMode,
  distancePointToPoint,
  distancePointToRectEdge,
  interpolateLinePriceAtIndex,
  pointInRectBounds,
  type Point2D,
} from './geometry.ts';
import { applyOhlcMagnet, type MagnetMode } from './magnet.ts';
import { FIB_DEFAULT_LEVELS, getToolDefinition, type DrawingToolType } from './tool-registry.ts';
import { UndoModel } from './undo-model.ts';

export interface CoordBridge {
  paneRect: { x: number; y: number; width: number; height: number };
  horizontalPixelRatio: number;
  verticalPixelRatio: number;
  indexToX: (barIndex: number) => number;
  xToIndex: (x: number) => number;
  priceToY: (price: number) => number;
  yToPrice: (y: number) => number;
  timeToIndex: (timeMs: number) => number;
  indexToTime: (barIndex: number) => number | null;
  getBar: (barIndex: number) => OHLCVBar | null;
  firstBarIndex: () => number;
  lastBarIndex: () => number;
  formatPrice: (price: number) => string;
}

export interface HitTestResult {
  drawingId: string;
  part: 'anchor' | 'body';
  anchorIndex?: number;
}

export interface AnchoredVwapPoint {
  barIndex: number;
  vwap: number;
  upper1: number;
  lower1: number;
  upper2: number;
  lower2: number;
}

/**
 * Computes institutional Anchored VWAP + ±1σ / ±2σ standard deviation bands from startIndex onward.
 */
export function computeAnchoredVwap(
  startIndex: number,
  endIndex: number,
  getBar: (barIndex: number) => OHLCVBar | null,
): AnchoredVwapPoint[] {
  const out: AnchoredVwapPoint[] = [];
  let cumPV = 0;
  let cumV = 0;
  let cumP2V = 0;

  for (let idx = startIndex; idx <= endIndex; idx++) {
    const b = getBar(idx);
    if (!b) continue;
    const tp = (b.high + b.low + b.close) / 3;
    // Fallback unit weight on zero-volume spot indices so Anchored TWAP still renders cleanly
    const v = b.volume > 0 ? b.volume : 1;
    cumPV += tp * v;
    cumV += v;
    cumP2V += tp * tp * v;
    const vwap = cumPV / cumV;
    const variance = Math.max(0, cumP2V / cumV - vwap * vwap);
    const std = Math.sqrt(variance);
    out.push({
      barIndex: idx,
      vwap,
      upper1: vwap + std,
      lower1: vwap - std,
      upper2: vwap + 2 * std,
      lower2: vwap - 2 * std,
    });
  }
  return out;
}

const ANCHOR_HIT_RADIUS_PX = 8;
const BODY_HIT_RADIUS_PX = 7;

export class DrawingManager {
  private drawings: DrawingEntity[] = [];
  readonly undoModel = new UndoModel(200);

  activeTool: DrawingToolType | null = null;
  magnetMode: MagnetMode = 'off';
  stayInDrawingMode = false;
  hideAll = false;
  selectedId: string | null = null;

  private draft: DrawingEntity | null = null;
  private dragState:
    | { kind: 'none' }
    | { kind: 'anchor'; id: string; anchorIdx: number; beforeAnchors: LogicalAnchor[] }
    | { kind: 'body'; id: string; startX: number; startY: number; beforeAnchors: LogicalAnchor[] }
    | { kind: 'freehand' } = { kind: 'none' };

  private listeners = new Set<() => void>();

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  getDrawings(symbol?: string): DrawingEntity[] {
    const list = symbol ? this.drawings.filter((d) => d.symbol === symbol) : this.drawings;
    return [...list].sort((a, b) => a.zIndex - b.zIndex);
  }

  getAllDrawings(): DrawingEntity[] {
    return [...this.drawings].sort((a, b) => a.zIndex - b.zIndex);
  }

  getSelected(): DrawingEntity | null {
    if (!this.selectedId) return null;
    return this.drawings.find((d) => d.id === this.selectedId) ?? null;
  }

  loadDrawings(entities: readonly DrawingEntity[]): void {
    this.drawings = entities.map((e) => ({
      ...e,
      anchors: e.anchors.map((a) => ({ ...a })),
      style: { ...e.style },
    }));
    this.draft = null;
    this.selectedId = null;
    this.notify();
  }

  addDrawing(entity: DrawingEntity): void {
    const clone: DrawingEntity = {
      ...entity,
      anchors: entity.anchors.map((a) => ({ ...a })),
      style: { ...entity.style },
    };
    this.undoModel.execute({
      label: `Add ${entity.type}`,
      execute: () => {
        this.drawings.push(clone);
        this.selectedId = clone.id;
        this.notify();
      },
      undo: () => {
        this.drawings = this.drawings.filter((d) => d.id !== clone.id);
        if (this.selectedId === clone.id) this.selectedId = null;
        this.notify();
      },
    });
  }

  updateStyle(id: string, patch: Record<string, unknown>): void {
    const target = this.drawings.find((d) => d.id === id);
    if (!target) return;
    const prev = { ...target.style };
    const next = { ...target.style, ...patch };
    this.undoModel.execute({
      label: `Style ${target.type}`,
      execute: () => {
        target.style = { ...next };
        this.notify();
      },
      undo: () => {
        target.style = { ...prev };
        this.notify();
      },
    });
  }

  toggleLock(id: string): void {
    const target = this.drawings.find((d) => d.id === id);
    if (!target) return;
    const prev = target.locked;
    this.undoModel.execute({
      label: prev ? 'Unlock drawing' : 'Lock drawing',
      execute: () => {
        target.locked = !prev;
        this.notify();
      },
      undo: () => {
        target.locked = prev;
        this.notify();
      },
    });
  }

  toggleVisibility(id: string): void {
    const target = this.drawings.find((d) => d.id === id);
    if (!target) return;
    const prev = target.visible;
    this.undoModel.execute({
      label: prev ? 'Hide drawing' : 'Show drawing',
      execute: () => {
        target.visible = !prev;
        this.notify();
      },
      undo: () => {
        target.visible = prev;
        this.notify();
      },
    });
  }

  deleteDrawing(id: string): void {
    const idx = this.drawings.findIndex((d) => d.id === id);
    if (idx === -1) return;
    const removed = this.drawings[idx]!;
    this.undoModel.execute({
      label: `Delete ${removed.type}`,
      execute: () => {
        this.drawings = this.drawings.filter((d) => d.id !== id);
        if (this.selectedId === id) this.selectedId = null;
        this.notify();
      },
      undo: () => {
        this.drawings.splice(idx, 0, removed);
        this.selectedId = removed.id;
        this.notify();
      },
    });
  }

  clearForSymbol(symbol: string): void {
    const snapshot = this.drawings.filter((d) => d.symbol === symbol);
    if (snapshot.length === 0) return;
    this.undoModel.execute({
      label: `Clear ${symbol} drawings`,
      execute: () => {
        this.drawings = this.drawings.filter((d) => d.symbol !== symbol);
        this.selectedId = null;
        this.notify();
      },
      undo: () => {
        this.drawings.push(...snapshot);
        this.notify();
      },
    });
  }

  undo(): boolean {
    const ok = this.undoModel.undo();
    if (ok) this.notify();
    return ok;
  }

  redo(): boolean {
    const ok = this.undoModel.redo();
    if (ok) this.notify();
    return ok;
  }

  anchorToPoint(anchor: LogicalAnchor, bridge: CoordBridge): Point2D {
    const baseIdx = bridge.timeToIndex(anchor.time);
    const barIndex = baseIdx + (anchor.logicalOffset ?? 0);
    return {
      x: bridge.indexToX(barIndex),
      y: bridge.priceToY(anchor.price),
    };
  }

  pointToAnchor(x: number, y: number, bridge: CoordBridge, applyMagnet = true): LogicalAnchor {
    const rawIdx = Math.round(bridge.xToIndex(x));
    const lastIdx = bridge.lastBarIndex();
    const clampedIdx = Math.max(bridge.firstBarIndex(), Math.min(lastIdx, rawIdx));
    const bar = bridge.getBar(clampedIdx);
    const rawPrice = bridge.yToPrice(y);
    const snapped = applyMagnet
      ? applyOhlcMagnet(this.magnetMode, y, rawPrice, bar, bridge.priceToY)
      : { price: rawPrice, snapped: false };

    const time = bridge.indexToTime(clampedIdx) ?? Date.now();
    const logicalOffset = rawIdx > lastIdx ? rawIdx - lastIdx : 0;
    return {
      time,
      ...(logicalOffset !== 0 ? { logicalOffset } : {}),
      price: snapped.price,
    };
  }

  /**
   * Computes exact sloped drawing price at barIndex for Alert Evaluation!
   */
  getPriceAtBar(drawing: DrawingEntity, barIndex: number, bridge: CoordBridge): number | null {
    if (drawing.type === 'horizontal_line' || drawing.type === 'horizontal_ray') {
      return drawing.anchors[0]?.price ?? null;
    }
    if (
      (drawing.type === 'trendline' ||
        drawing.type === 'ray' ||
        drawing.type === 'extended_line' ||
        drawing.type === 'info_line') &&
      drawing.anchors.length >= 2
    ) {
      const a0 = drawing.anchors[0]!;
      const a1 = drawing.anchors[1]!;
      const i0 = bridge.timeToIndex(a0.time) + (a0.logicalOffset ?? 0);
      const i1 = bridge.timeToIndex(a1.time) + (a1.logicalOffset ?? 0);
      const mode =
        drawing.type === 'ray' ? 'ray' : drawing.type === 'extended_line' ? 'extended' : 'segment';
      return interpolateLinePriceAtIndex(i0, a0.price, i1, a1.price, barIndex, mode);
    }
    return null;
  }

  hitTest(point: Point2D, symbol: string, bridge: CoordBridge): HitTestResult | null {
    if (this.hideAll) return null;
    const list = this.getDrawings(symbol).reverse(); // Topmost z-order first

    for (const d of list) {
      if (!d.visible) continue;
      const pts = d.anchors.map((a) => this.anchorToPoint(a, bridge));

      // Anchor handle hit-test takes priority
      if (d.id === this.selectedId && !d.locked) {
        for (let i = 0; i < pts.length; i++) {
          if (distancePointToPoint(point, pts[i]!) <= ANCHOR_HIT_RADIUS_PX) {
            return { drawingId: d.id, part: 'anchor', anchorIndex: i };
          }
        }
      }

      if (this.hitTestBody(d, pts, point, bridge)) {
        return { drawingId: d.id, part: 'body' };
      }
    }
    return null;
  }

  private hitTestBody(d: DrawingEntity, pts: Point2D[], p: Point2D, bridge: CoordBridge): boolean {
    const p0 = pts[0];
    const p1 = pts[1];
    const p2 = pts[2];
    if (!p0) return false;

    switch (d.type) {
      case 'horizontal_line':
        return Math.abs(p.y - p0.y) <= BODY_HIT_RADIUS_PX;
      case 'horizontal_ray':
        return Math.abs(p.y - p0.y) <= BODY_HIT_RADIUS_PX && p.x >= p0.x - BODY_HIT_RADIUS_PX;
      case 'vertical_line':
        return Math.abs(p.x - p0.x) <= BODY_HIT_RADIUS_PX;
      case 'cross_line':
        return Math.abs(p.x - p0.x) <= BODY_HIT_RADIUS_PX || Math.abs(p.y - p0.y) <= BODY_HIT_RADIUS_PX;
      case 'trendline':
      case 'info_line':
      case 'trend_angle':
      case 'callout':
        return p1 ? distancePointToLineMode(p, p0, p1, 'segment') <= BODY_HIT_RADIUS_PX : false;
      case 'ray':
        return p1 ? distancePointToLineMode(p, p0, p1, 'ray') <= BODY_HIT_RADIUS_PX : false;
      case 'extended_line':
        return p1 ? distancePointToLineMode(p, p0, p1, 'extended') <= BODY_HIT_RADIUS_PX : false;
      case 'parallel_channel':
      case 'disjoint_channel':
      case 'flat_channel': {
        if (!p1 || !p2) return false;
        const dy = p2.y - p0.y;
        const p1Shift: Point2D = { x: p1.x, y: p1.y + dy };
        return (
          distancePointToLineMode(p, p0, p1, 'segment') <= BODY_HIT_RADIUS_PX ||
          distancePointToLineMode(p, p2, p1Shift, 'segment') <= BODY_HIT_RADIUS_PX
        );
      }
      case 'rectangle':
      case 'measure':
      case 'date_range':
      case 'price_range':
      case 'date_price_range':
      case 'fib_retracement':
      case 'gann_box':
      case 'fib_time_zones':
      case 'fib_speed_fan':
      case 'gann_fan':
      case 'cyclic_lines':
      case 'regression_trend':
      case 'fixed_range_vp':
        if (!p1) return false;
        return distancePointToRectEdge(p, p0, p1) <= BODY_HIT_RADIUS_PX || pointInRectBounds(p, p0, p1, 0);
      case 'circle':
      case 'fib_circles':
        return p1 ? distancePointToCircleBorder(p, p0, p1) <= BODY_HIT_RADIUS_PX : false;
      case 'andrews_pitchfork':
      case 'schiff_pitchfork':
      case 'modified_schiff_pitchfork':
      case 'inside_pitchfork': {
        if (!p1 || !p2) return false;
        const mid: Point2D = { x: (p1.x + p2.x) * 0.5, y: (p1.y + p2.y) * 0.5 };
        return (
          distancePointToLineMode(p, p0, mid, 'ray') <= BODY_HIT_RADIUS_PX ||
          distancePointToLineMode(p, p1, p2, 'segment') <= BODY_HIT_RADIUS_PX
        );
      }
      case 'long_position':
      case 'short_position':
        if (!p1 || !p2) return false;
        return (
          pointInRectBounds(p, p0, p1, 2) ||
          pointInRectBounds(p, p0, { x: p1.x, y: p2.y }, 2)
        );
      case 'brush':
      case 'highlighter':
      case 'polyline':
      case 'triangle':
      case 'elliott_impulse_12345':
      case 'elliott_correction_abc':
      case 'harmonic_xabcd':
      case 'head_and_shoulders': {
        for (let i = 1; i < pts.length; i++) {
          if (distancePointToLineMode(p, pts[i - 1]!, pts[i]!, 'segment') <= BODY_HIT_RADIUS_PX) {
            return true;
          }
        }
        return false;
      }
      case 'anchored_vwap': {
        const startIdx = bridge.timeToIndex(d.anchors[0]!.time);
        const endIdx = bridge.lastBarIndex();
        const curve = computeAnchoredVwap(startIdx, endIdx, bridge.getBar);
        for (let i = 1; i < curve.length; i++) {
          const a: Point2D = { x: bridge.indexToX(curve[i - 1]!.barIndex), y: bridge.priceToY(curve[i - 1]!.vwap) };
          const b: Point2D = { x: bridge.indexToX(curve[i]!.barIndex), y: bridge.priceToY(curve[i]!.vwap) };
          if (distancePointToLineMode(p, a, b, 'segment') <= BODY_HIT_RADIUS_PX) return true;
        }
        return false;
      }
      default:
        return distancePointToPoint(p, p0) <= 14;
    }
  }

  /**
   * Handles pointerdown inside main pane. Returns true if drawing engine consumed the event
   * (preventing chart pan while placing/dragging a drawing).
   */
  handlePointerDown(x: number, y: number, symbol: string, bridge: CoordBridge): boolean {
    if (this.activeTool) {
      const def = getToolDefinition(this.activeTool);
      const anchor = this.pointToAnchor(x, y, bridge, true);

      if (def.requiredAnchors === 'freehand') {
        this.draft = this.createDraftEntity(this.activeTool, symbol, [anchor]);
        this.dragState = { kind: 'freehand' };
        this.notify();
        return true;
      }

      if (!this.draft) {
        if (def.requiredAnchors === 1) {
          const entity = this.createDraftEntity(this.activeTool, symbol, [anchor]);
          this.addDrawing(entity);
          if (!this.stayInDrawingMode) this.activeTool = null;
          return true;
        }
        // Long/Short position pre-populates realistic 2:1 Target & Stop anchors on first click
        if (this.activeTool === 'long_position' || this.activeTool === 'short_position') {
          const entryIdx = Math.round(bridge.xToIndex(x));
          const spanBars = 24;
          const targetIdx = Math.min(bridge.lastBarIndex() + 20, entryIdx + spanBars);
          const priceSpan = Math.abs(bridge.yToPrice(bridge.paneRect.y + 80) - bridge.yToPrice(bridge.paneRect.y + 180));
          const dir = this.activeTool === 'long_position' ? 1 : -1;
          const tpAnchor: LogicalAnchor = {
            time: bridge.indexToTime(Math.min(bridge.lastBarIndex(), targetIdx)) ?? anchor.time,
            ...(targetIdx > bridge.lastBarIndex() ? { logicalOffset: targetIdx - bridge.lastBarIndex() } : {}),
            price: anchor.price + dir * priceSpan * 1.4,
          };
          const slAnchor: LogicalAnchor = {
            ...tpAnchor,
            price: anchor.price - dir * priceSpan * 0.7,
          };
          const entity = this.createDraftEntity(this.activeTool, symbol, [anchor, tpAnchor, slAnchor]);
          this.addDrawing(entity);
          if (!this.stayInDrawingMode) this.activeTool = null;
          return true;
        }

        this.draft = this.createDraftEntity(this.activeTool, symbol, [anchor, { ...anchor }]);
        this.notify();
        return true;
      }

      // Advance multi-anchor draft
      const idx = this.draft.anchors.length - 1;
      this.draft.anchors[idx] = anchor;
      if (this.draft.anchors.length >= def.requiredAnchors) {
        const finalized = this.draft;
        this.draft = null;
        this.addDrawing(finalized);
        if (!this.stayInDrawingMode) this.activeTool = null;
      } else {
        this.draft.anchors.push({ ...anchor });
        this.notify();
      }
      return true;
    }

    // Idle cursor mode: check hit test on existing drawings
    const hit = this.hitTest({ x, y }, symbol, bridge);
    if (!hit) {
      if (this.selectedId !== null) {
        this.selectedId = null;
        this.notify();
      }
      return false;
    }

    const entity = this.drawings.find((d) => d.id === hit.drawingId);
    if (!entity) return false;
    this.selectedId = entity.id;

    if (entity.locked) {
      this.notify();
      return true;
    }

    const beforeAnchors = entity.anchors.map((a) => ({ ...a }));
    if (hit.part === 'anchor' && hit.anchorIndex !== undefined) {
      this.dragState = { kind: 'anchor', id: entity.id, anchorIdx: hit.anchorIndex, beforeAnchors };
    } else {
      this.dragState = { kind: 'body', id: entity.id, startX: x, startY: y, beforeAnchors };
    }
    this.notify();
    return true;
  }

  handlePointerMove(x: number, y: number, bridge: CoordBridge): boolean {
    if (this.dragState.kind === 'freehand' && this.draft) {
      const anchor = this.pointToAnchor(x, y, bridge, false);
      this.draft.anchors.push(anchor);
      this.notify();
      return true;
    }

    if (this.draft && this.draft.anchors.length >= 2) {
      this.draft.anchors[this.draft.anchors.length - 1] = this.pointToAnchor(x, y, bridge, true);
      this.notify();
      return true;
    }

    const drag = this.dragState;
    if (drag.kind === 'anchor') {
      const entity = this.drawings.find((d) => d.id === drag.id);
      if (!entity) return false;
      entity.anchors[drag.anchorIdx] = this.pointToAnchor(x, y, bridge, true);
      this.notify();
      return true;
    }

    if (drag.kind === 'body') {
      const entity = this.drawings.find((d) => d.id === drag.id);
      if (!entity) return false;
      const dx = x - drag.startX;
      const dy = y - drag.startY;
      entity.anchors = drag.beforeAnchors.map((orig) => {
        const pt = this.anchorToPoint(orig, bridge);
        return this.pointToAnchor(pt.x + dx, pt.y + dy, bridge, false);
      });
      this.notify();
      return true;
    }

    return false;
  }

  handlePointerUp(): boolean {
    if (this.dragState.kind === 'freehand' && this.draft) {
      const finalized = this.draft;
      this.draft = null;
      this.dragState = { kind: 'none' };
      if (finalized.anchors.length > 1) {
        this.addDrawing(finalized);
      }
      if (!this.stayInDrawingMode) this.activeTool = null;
      return true;
    }

    if (this.dragState.kind === 'anchor' || this.dragState.kind === 'body') {
      const id = this.dragState.id;
      const before = this.dragState.beforeAnchors;
      const entity = this.drawings.find((d) => d.id === id);
      this.dragState = { kind: 'none' };
      if (entity) {
        const after = entity.anchors.map((a) => ({ ...a }));
        // Record reversible move command on UndoModel
        this.undoModel.execute({
          label: `Move ${entity.type}`,
          execute: () => {
            entity.anchors = after.map((a) => ({ ...a }));
            this.notify();
          },
          undo: () => {
            entity.anchors = before.map((a) => ({ ...a }));
            this.notify();
          },
        });
      }
      return true;
    }

    return false;
  }

  private createDraftEntity(
    type: DrawingToolType,
    symbol: string,
    anchors: LogicalAnchor[],
  ): DrawingEntity {
    const def = getToolDefinition(type);
    const maxZ = this.drawings.reduce((m, d) => Math.max(m, d.zIndex), 0);
    return {
      id: `drw_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      type,
      paneId: 'main',
      priceScaleId: 'right',
      symbol,
      anchors,
      style: {
        color: def.defaultColor,
        lineWidth: def.defaultLineWidth,
        dashed: false,
        text: type === 'text' || type === 'anchored_text' || type === 'callout' || type === 'note' ? 'Note' : undefined,
      },
      locked: false,
      visible: true,
      zIndex: maxZ + 1,
    };
  }

  renderCommitted(ctx: CanvasRenderingContext2D, symbol: string, bridge: CoordBridge): void {
    if (this.hideAll) return;
    for (const d of this.getDrawings(symbol)) {
      if (!d.visible) continue;
      this.renderEntity(ctx, d, bridge, d.id === this.selectedId);
    }
  }

  renderDraftAndHandles(ctx: CanvasRenderingContext2D, symbol: string, bridge: CoordBridge): void {
    if (this.draft && this.draft.symbol === symbol) {
      this.renderEntity(ctx, this.draft, bridge, true);
    }
    const sel = this.getSelected();
    if (!this.hideAll && sel && sel.visible && sel.symbol === symbol && !sel.locked) {
      const pts = sel.anchors.map((a) => this.anchorToPoint(a, bridge));
      ctx.save();
      ctx.setTransform(bridge.horizontalPixelRatio, 0, 0, bridge.verticalPixelRatio, 0, 0);
      for (const p of pts) {
        ctx.fillStyle = '#0b0e14';
        ctx.strokeStyle = '#2962ff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  private renderEntity(
    ctx: CanvasRenderingContext2D,
    d: DrawingEntity,
    bridge: CoordBridge,
    selected: boolean,
  ): void {
    const pts = d.anchors.map((a) => this.anchorToPoint(a, bridge));
    const p0 = pts[0];
    if (!p0) return;
    const p1 = pts[1];
    const p2 = pts[2];
    const color = String(d.style.color ?? '#2962ff');
    const lineWidth = Number(d.style.lineWidth ?? 1.5);
    const dashed = Boolean(d.style.dashed);
    const { paneRect } = bridge;

    ctx.save();
    ctx.setTransform(bridge.horizontalPixelRatio, 0, 0, bridge.verticalPixelRatio, 0, 0);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = selected ? lineWidth + 0.5 : lineWidth;
    if (dashed) ctx.setLineDash([6, 4]);

    switch (d.type) {
      case 'horizontal_line': {
        ctx.beginPath();
        ctx.moveTo(paneRect.x, p0.y);
        ctx.lineTo(paneRect.x + paneRect.width, p0.y);
        ctx.stroke();
        break;
      }
      case 'horizontal_ray': {
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(paneRect.x + paneRect.width, p0.y);
        ctx.stroke();
        break;
      }
      case 'vertical_line': {
        ctx.beginPath();
        ctx.moveTo(p0.x, paneRect.y);
        ctx.lineTo(p0.x, paneRect.y + paneRect.height);
        ctx.stroke();
        break;
      }
      case 'cross_line': {
        ctx.beginPath();
        ctx.moveTo(paneRect.x, p0.y);
        ctx.lineTo(paneRect.x + paneRect.width, p0.y);
        ctx.moveTo(p0.x, paneRect.y);
        ctx.lineTo(p0.x, paneRect.y + paneRect.height);
        ctx.stroke();
        break;
      }
      case 'trendline':
      case 'info_line':
      case 'trend_angle':
      case 'ray':
      case 'extended_line': {
        if (!p1) break;
        const dx = p1.x - p0.x;
        const dy = p1.y - p0.y;
        let sx = p0.x;
        let sy = p0.y;
        let ex = p1.x;
        let ey = p1.y;
        const len = Math.hypot(dx, dy);
        if (len > 1e-3 && (d.type === 'ray' || d.type === 'extended_line')) {
          const ux = dx / len;
          const uy = dy / len;
          const extend = paneRect.width + paneRect.height;
          ex = p0.x + ux * extend;
          ey = p0.y + uy * extend;
          if (d.type === 'extended_line') {
            sx = p0.x - ux * extend;
            sy = p0.y - uy * extend;
          }
        }
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(ex, ey);
        ctx.stroke();

        if (d.type === 'info_line' || d.type === 'trend_angle') {
          const dp = d.anchors[1]!.price - d.anchors[0]!.price;
          const pct = d.anchors[0]!.price !== 0 ? (dp / d.anchors[0]!.price) * 100 : 0;
          const angleDeg = (-Math.atan2(dy, dx) * 180) / Math.PI;
          const label =
            d.type === 'trend_angle'
              ? `${angleDeg.toFixed(1)}°`
              : `${dp >= 0 ? '+' : ''}${dp.toFixed(2)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
          ctx.font = '600 11px monospace';
          ctx.fillText(label, (p0.x + p1.x) * 0.5 + 8, (p0.y + p1.y) * 0.5 - 8);
        }
        break;
      }
      case 'parallel_channel':
      case 'disjoint_channel':
      case 'flat_channel': {
        if (!p1) break;
        const offsetY = p2 ? p2.y - p0.y : 40;
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.moveTo(p0.x, p0.y + offsetY);
        ctx.lineTo(p1.x, p1.y + offsetY);
        ctx.stroke();
        ctx.fillStyle = `${color}22`;
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.lineTo(p1.x, p1.y + offsetY);
        ctx.lineTo(p0.x, p0.y + offsetY);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'fib_retracement':
      case 'fib_extension':
      case 'fib_channel': {
        if (!p1) break;
        const leftX = Math.min(p0.x, p1.x);
        const rightX = Math.max(p0.x, p1.x);
        const pHigh = d.anchors[0]!.price;
        const pLow = d.anchors[1]!.price;
        const diff = pHigh - pLow;
        ctx.font = '500 10.5px monospace';
        for (const lvl of FIB_DEFAULT_LEVELS) {
          const price = pLow + diff * lvl.ratio;
          const ly = bridge.priceToY(price);
          ctx.strokeStyle = lvl.color;
          ctx.beginPath();
          ctx.moveTo(leftX, ly);
          ctx.lineTo(rightX, ly);
          ctx.stroke();
          ctx.fillStyle = lvl.color;
          ctx.fillText(`${lvl.ratio.toFixed(3)} (${bridge.formatPrice(price)})`, leftX + 4, ly - 3);
        }
        break;
      }
      case 'rectangle':
      case 'measure':
      case 'date_range':
      case 'price_range':
      case 'date_price_range': {
        if (!p1) break;
        const rx = Math.min(p0.x, p1.x);
        const ry = Math.min(p0.y, p1.y);
        const rw = Math.abs(p1.x - p0.x);
        const rh = Math.abs(p1.y - p0.y);
        ctx.fillStyle = `${color}22`;
        ctx.fillRect(rx, ry, rw, rh);
        ctx.strokeRect(rx, ry, rw, rh);
        if (d.type !== 'rectangle') {
          const dp = d.anchors[1]!.price - d.anchors[0]!.price;
          const pct = d.anchors[0]!.price !== 0 ? (dp / d.anchors[0]!.price) * 100 : 0;
          const bars = Math.abs(bridge.timeToIndex(d.anchors[1]!.time) - bridge.timeToIndex(d.anchors[0]!.time));
          const txt = `${dp >= 0 ? '+' : ''}${dp.toFixed(2)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%) · ${bars} bars`;
          ctx.font = '600 11px monospace';
          ctx.fillStyle = color;
          ctx.fillText(txt, rx + 6, ry + rh + 14);
        }
        break;
      }
      case 'circle': {
        if (!p1) break;
        const r = distancePointToPoint(p0, p1);
        ctx.fillStyle = `${color}1e`;
        ctx.beginPath();
        ctx.arc(p0.x, p0.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        break;
      }
      case 'fib_circles': {
        if (!p1) break;
        const baseR = distancePointToPoint(p0, p1);
        for (const mult of [0.382, 0.618, 1, 1.618, 2.618]) {
          ctx.beginPath();
          ctx.arc(p0.x, p0.y, baseR * mult, 0, Math.PI * 2);
          ctx.stroke();
        }
        break;
      }
      case 'andrews_pitchfork':
      case 'schiff_pitchfork':
      case 'modified_schiff_pitchfork':
      case 'inside_pitchfork': {
        if (!p1 || !p2) break;
        const mid: Point2D = { x: (p1.x + p2.x) * 0.5, y: (p1.y + p2.y) * 0.5 };
        let origin = p0;
        if (d.type === 'schiff_pitchfork') origin = { x: p0.x, y: (p0.y + p1.y) * 0.5 };
        else if (d.type === 'modified_schiff_pitchfork') origin = { x: (p0.x + p1.x) * 0.5, y: (p0.y + p1.y) * 0.5 };
        else if (d.type === 'inside_pitchfork') origin = { x: (p0.x + mid.x) * 0.5, y: (p0.y + mid.y) * 0.5 };

        const dx = mid.x - origin.x;
        const dy = mid.y - origin.y;
        const len = Math.max(1e-3, Math.hypot(dx, dy));
        const ext = paneRect.width + paneRect.height;
        const ux = (dx / len) * ext;
        const uy = (dy / len) * ext;

        // Median + Upper/Lower prongs + handle
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.moveTo(origin.x, origin.y);
        ctx.lineTo(origin.x + ux, origin.y + uy);
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p1.x + ux, p1.y + uy);
        ctx.moveTo(p2.x, p2.y);
        ctx.lineTo(p2.x + ux, p2.y + uy);
        ctx.stroke();
        break;
      }
      case 'gann_box': {
        if (!p1) break;
        const rx = Math.min(p0.x, p1.x);
        const ry = Math.min(p0.y, p1.y);
        const rw = Math.abs(p1.x - p0.x);
        const rh = Math.abs(p1.y - p0.y);
        ctx.strokeRect(rx, ry, rw, rh);
        ctx.save();
        ctx.setLineDash([3, 3]);
        for (const r of [0.25, 0.5, 0.75]) {
          ctx.beginPath();
          ctx.moveTo(rx + rw * r, ry);
          ctx.lineTo(rx + rw * r, ry + rh);
          ctx.moveTo(rx, ry + rh * r);
          ctx.lineTo(rx + rw, ry + rh * r);
          ctx.stroke();
        }
        // Diagonals
        ctx.beginPath();
        ctx.moveTo(rx, ry);
        ctx.lineTo(rx + rw, ry + rh);
        ctx.moveTo(rx, ry + rh);
        ctx.lineTo(rx + rw, ry);
        ctx.stroke();
        ctx.restore();
        break;
      }
      case 'gann_fan':
      case 'fib_speed_fan': {
        if (!p1) break;
        const dx = p1.x - p0.x;
        const dy = p1.y - p0.y;
        const ratios = d.type === 'gann_fan' ? [0.25, 0.5, 1, 2, 4] : [0.25, 0.382, 0.5, 0.618, 0.75, 1];
        for (const r of ratios) {
          ctx.beginPath();
          ctx.moveTo(p0.x, p0.y);
          ctx.lineTo(p0.x + dx * 4, p0.y + dy * r * 4);
          ctx.stroke();
        }
        break;
      }
      case 'fib_time_zones':
      case 'cyclic_lines': {
        if (!p1) break;
        const stepX = p1.x - p0.x;
        if (Math.abs(stepX) < 2) break;
        const mults = d.type === 'fib_time_zones' ? [0, 1, 2, 3, 5, 8, 13, 21, 34] : [0, 1, 2, 3, 4, 5, 6, 7, 8];
        for (const m of mults) {
          const x = p0.x + stepX * m;
          if (x < paneRect.x || x > paneRect.x + paneRect.width) continue;
          ctx.beginPath();
          ctx.moveTo(x, paneRect.y);
          ctx.lineTo(x, paneRect.y + paneRect.height);
          ctx.stroke();
        }
        break;
      }
      case 'regression_trend': {
        if (!p1) break;
        const i0 = Math.min(bridge.timeToIndex(d.anchors[0]!.time), bridge.timeToIndex(d.anchors[1]!.time));
        const i1 = Math.max(bridge.timeToIndex(d.anchors[0]!.time), bridge.timeToIndex(d.anchors[1]!.time));
        const xs: number[] = [];
        const ys: number[] = [];
        for (let idx = i0; idx <= i1; idx++) {
          const b = bridge.getBar(idx);
          if (b) { xs.push(idx); ys.push(b.close); }
        }
        if (xs.length < 2) break;
        const n = xs.length;
        const meanX = xs.reduce((a, b) => a + b, 0) / n;
        const meanY = ys.reduce((a, b) => a + b, 0) / n;
        let num = 0;
        let den = 0;
        for (let k = 0; k < n; k++) {
          num += (xs[k]! - meanX) * (ys[k]! - meanY);
          den += (xs[k]! - meanX) ** 2;
        }
        const slope = den > 0 ? num / den : 0;
        const intercept = meanY - slope * meanX;
        let ss = 0;
        for (let k = 0; k < n; k++) {
          const pred = intercept + slope * xs[k]!;
          ss += (ys[k]! - pred) ** 2;
        }
        const std = Math.sqrt(ss / n);
        const yStart = intercept + slope * i0;
        const yEnd = intercept + slope * i1;
        const x0 = bridge.indexToX(i0);
        const x1 = bridge.indexToX(i1);
        for (const mult of [-2, 0, 2]) {
          ctx.save();
          if (mult !== 0) ctx.setLineDash([4, 3]);
          ctx.beginPath();
          ctx.moveTo(x0, bridge.priceToY(yStart + mult * std));
          ctx.lineTo(x1, bridge.priceToY(yEnd + mult * std));
          ctx.stroke();
          ctx.restore();
        }
        break;
      }
      case 'fixed_range_vp': {
        if (!p1) break;
        const i0 = Math.min(bridge.timeToIndex(d.anchors[0]!.time), bridge.timeToIndex(d.anchors[1]!.time));
        const i1 = Math.max(bridge.timeToIndex(d.anchors[0]!.time), bridge.timeToIndex(d.anchors[1]!.time));
        const rx = Math.min(p0.x, p1.x);
        const rw = Math.max(24, Math.abs(p1.x - p0.x));
        let minP = Infinity;
        let maxP = -Infinity;
        const slice: OHLCVBar[] = [];
        for (let idx = i0; idx <= i1; idx++) {
          const b = bridge.getBar(idx);
          if (!b) continue;
          slice.push(b);
          if (b.low < minP) minP = b.low;
          if (b.high > maxP) maxP = b.high;
        }
        if (slice.length === 0 || maxP <= minP) break;
        const bins = 24;
        const step = (maxP - minP) / bins;
        const volBins = new Float64Array(bins);
        for (const b of slice) {
          const v = b.volume > 0 ? b.volume : 1;
          const b0 = Math.max(0, Math.min(bins - 1, Math.floor((b.low - minP) / step)));
          const b1 = Math.max(b0, Math.min(bins - 1, Math.floor((b.high - minP) / step)));
          const per = v / (b1 - b0 + 1);
          for (let k = b0; k <= b1; k++) volBins[k] = volBins[k]! + per;
        }
        let maxV = 0;
        let pocIdx = 0;
        for (let k = 0; k < bins; k++) {
          if (volBins[k]! > maxV) { maxV = volBins[k]!; pocIdx = k; }
        }
        const barMaxW = rw * 0.45;
        for (let k = 0; k < bins; k++) {
          const yTop = bridge.priceToY(minP + (k + 1) * step);
          const yBot = bridge.priceToY(minP + k * step);
          const w = maxV > 0 ? (volBins[k]! / maxV) * barMaxW : 0;
          ctx.fillStyle = k === pocIdx ? 'rgba(247, 147, 26, 0.7)' : 'rgba(41, 98, 255, 0.35)';
          ctx.fillRect(rx, Math.min(yTop, yBot), w, Math.max(1, Math.abs(yBot - yTop) - 1));
        }
        const pocY = bridge.priceToY(minP + (pocIdx + 0.5) * step);
        ctx.strokeStyle = '#f7931a';
        ctx.beginPath();
        ctx.moveTo(rx, pocY);
        ctx.lineTo(rx + rw, pocY);
        ctx.stroke();
        break;
      }
      case 'elliott_impulse_12345':
      case 'elliott_correction_abc':
      case 'harmonic_xabcd':
      case 'head_and_shoulders': {
        if (pts.length < 2) break;
        const labels =
          d.type === 'elliott_impulse_12345'
            ? ['0', '1', '2', '3', '4', '5']
            : d.type === 'elliott_correction_abc'
              ? ['0', 'A', 'B', 'C']
              : d.type === 'harmonic_xabcd'
                ? ['X', 'A', 'B', 'C', 'D']
                : ['L', 'LS', 'N1', 'H', 'N2', 'RS', 'R'];
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
        ctx.stroke();
        if (d.type === 'harmonic_xabcd' && pts.length >= 5) {
          ctx.fillStyle = `${color}22`;
          ctx.beginPath();
          ctx.moveTo(pts[0]!.x, pts[0]!.y);
          ctx.lineTo(pts[1]!.x, pts[1]!.y);
          ctx.lineTo(pts[2]!.x, pts[2]!.y);
          ctx.closePath();
          ctx.fill();
          ctx.beginPath();
          ctx.moveTo(pts[2]!.x, pts[2]!.y);
          ctx.lineTo(pts[3]!.x, pts[3]!.y);
          ctx.lineTo(pts[4]!.x, pts[4]!.y);
          ctx.closePath();
          ctx.fill();
        }
        ctx.font = '700 11px monospace';
        ctx.fillStyle = color;
        for (let i = 0; i < pts.length; i++) {
          ctx.fillText(labels[i] ?? String(i), pts[i]!.x + 4, pts[i]!.y - 6);
        }
        break;
      }
      case 'long_position':
      case 'short_position': {
        if (!p1 || !p2) break;
        const leftX = Math.min(p0.x, p1.x);
        const width = Math.max(40, Math.abs(p1.x - p0.x));
        const entryY = p0.y;
        const tpY = p1.y;
        const slY = p2.y;
        // Profit zone (green)
        ctx.fillStyle = 'rgba(8, 153, 129, 0.22)';
        ctx.fillRect(leftX, Math.min(entryY, tpY), width, Math.abs(tpY - entryY));
        ctx.strokeStyle = '#089981';
        ctx.strokeRect(leftX, Math.min(entryY, tpY), width, Math.abs(tpY - entryY));
        // Risk zone (red)
        ctx.fillStyle = 'rgba(242, 54, 69, 0.22)';
        ctx.fillRect(leftX, Math.min(entryY, slY), width, Math.abs(slY - entryY));
        ctx.strokeStyle = '#f23645';
        ctx.strokeRect(leftX, Math.min(entryY, slY), width, Math.abs(slY - entryY));

        const entry = d.anchors[0]!.price;
        const tp = d.anchors[1]!.price;
        const sl = d.anchors[2]!.price;
        const reward = Math.abs(tp - entry);
        const risk = Math.max(1e-9, Math.abs(entry - sl));
        const rr = reward / risk;
        ctx.fillStyle = '#ffffff';
        ctx.font = '600 11px monospace';
        ctx.fillText(`R:R ${rr.toFixed(2)} · Target ${bridge.formatPrice(tp)} · Stop ${bridge.formatPrice(sl)}`, leftX + 6, entryY - 6);
        break;
      }
      case 'anchored_vwap': {
        const startIdx = bridge.timeToIndex(d.anchors[0]!.time);
        const endIdx = bridge.lastBarIndex();
        const curve = computeAnchoredVwap(startIdx, endIdx, bridge.getBar);
        if (curve.length < 2) break;
        const drawCurve = (getter: (pt: AnchoredVwapPoint) => number, stroke: string, widthPx: number, dash: number[] = []) => {
          ctx.save();
          ctx.strokeStyle = stroke;
          ctx.lineWidth = widthPx;
          ctx.setLineDash(dash);
          ctx.beginPath();
          for (let i = 0; i < curve.length; i++) {
            const x = bridge.indexToX(curve[i]!.barIndex);
            const y = bridge.priceToY(getter(curve[i]!));
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.stroke();
          ctx.restore();
        };
        drawCurve((c) => c.vwap, color, lineWidth);
        drawCurve((c) => c.upper1, `${color}99`, 1, [4, 3]);
        drawCurve((c) => c.lower1, `${color}99`, 1, [4, 3]);
        drawCurve((c) => c.upper2, `${color}55`, 1, [2, 3]);
        drawCurve((c) => c.lower2, `${color}55`, 1, [2, 3]);
        break;
      }
      case 'brush':
      case 'highlighter':
      case 'polyline':
      case 'triangle': {
        if (pts.length < 2) break;
        ctx.globalAlpha = d.type === 'highlighter' ? 0.35 : 1;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
        if (d.type === 'triangle' && pts.length === 3) ctx.closePath();
        ctx.stroke();
        break;
      }
      default: {
        // Text, Note, Callout, Price Label, Arrow Markers
        if (d.type === 'arrow_up' || d.type === 'arrow_down') {
          const dir = d.type === 'arrow_up' ? -1 : 1;
          ctx.beginPath();
          ctx.moveTo(p0.x, p0.y);
          ctx.lineTo(p0.x - 7, p0.y - dir * 12);
          ctx.lineTo(p0.x + 7, p0.y - dir * 12);
          ctx.closePath();
          ctx.fill();
        } else {
          const txt =
            d.type === 'price_label'
              ? bridge.formatPrice(d.anchors[0]!.price)
              : String(d.style.text ?? d.type);
          ctx.font = '600 12px Inter, sans-serif';
          const tw = ctx.measureText(txt).width;
          ctx.fillStyle = `${color}28`;
          ctx.fillRect(p0.x - 4, p0.y - 12, tw + 12, 22);
          ctx.strokeRect(p0.x - 4, p0.y - 12, tw + 12, 22);
          ctx.fillStyle = '#ffffff';
          ctx.fillText(txt, p0.x + 2, p0.y + 3);
        }
        break;
      }
    }

    ctx.restore();
  }
}
