export interface Point2D {
  x: number;
  y: number;
}

export function distancePointToPoint(a: Point2D, b: Point2D): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Analytical shortest distance from point P to line segment AB (mode='segment'),
 * ray A -> B -> inf (mode='ray'), or infinite line through AB (mode='extended').
 */
export function distancePointToLineMode(
  p: Point2D,
  a: Point2D,
  b: Point2D,
  mode: 'segment' | 'ray' | 'extended' = 'segment',
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-9) return distancePointToPoint(p, a);

  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  if (mode === 'segment') t = Math.max(0, Math.min(1, t));
  else if (mode === 'ray') t = Math.max(0, t);

  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  return Math.hypot(p.x - projX, p.y - projY);
}

export function pointInRectBounds(p: Point2D, a: Point2D, b: Point2D, pad = 4): boolean {
  const minX = Math.min(a.x, b.x) - pad;
  const maxX = Math.max(a.x, b.x) + pad;
  const minY = Math.min(a.y, b.y) - pad;
  const maxY = Math.max(a.y, b.y) + pad;
  return p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY;
}

export function distancePointToRectEdge(p: Point2D, a: Point2D, b: Point2D): number {
  const c1: Point2D = { x: a.x, y: a.y };
  const c2: Point2D = { x: b.x, y: a.y };
  const c3: Point2D = { x: b.x, y: b.y };
  const c4: Point2D = { x: a.x, y: b.y };
  return Math.min(
    distancePointToLineMode(p, c1, c2, 'segment'),
    distancePointToLineMode(p, c2, c3, 'segment'),
    distancePointToLineMode(p, c3, c4, 'segment'),
    distancePointToLineMode(p, c4, c1, 'segment'),
  );
}

export function distancePointToCircleBorder(p: Point2D, center: Point2D, edgePoint: Point2D): number {
  const radius = distancePointToPoint(center, edgePoint);
  const dist = distancePointToPoint(p, center);
  return Math.abs(dist - radius);
}

/**
 * Exact sloped trendline price interpolation at targetIndex.
 * Used both for extended rendering AND Phase 8 Sloped Trendline Crossing Alerts!
 */
export function interpolateLinePriceAtIndex(
  idx1: number,
  price1: number,
  idx2: number,
  price2: number,
  targetIdx: number,
  mode: 'segment' | 'ray' | 'extended' = 'extended',
): number | null {
  if (Math.abs(idx2 - idx1) < 1e-9) return null;
  if (mode === 'segment') {
    const lo = Math.min(idx1, idx2);
    const hi = Math.max(idx1, idx2);
    if (targetIdx < lo || targetIdx > hi) return null;
  } else if (mode === 'ray') {
    if (idx2 > idx1 && targetIdx < idx1) return null;
    if (idx2 < idx1 && targetIdx > idx1) return null;
  }
  return price1 + ((price2 - price1) / (idx2 - idx1)) * (targetIdx - idx1);
}
