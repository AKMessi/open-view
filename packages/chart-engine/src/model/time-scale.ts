import { getLocalParts } from './session-calendar.ts';

export interface TimeTickMark {
  barIndex: number;
  x: number;
  label: string;
  weight: number;
  bold: boolean;
}

export const MIN_BAR_SPACING = 0.15;
export const MAX_BAR_SPACING = 220;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/**
 * Horizontal Logical-Index Axis Engine.
 * Maps contiguous integer bar indices <-> CSS pixel coordinates, decoupling market weekend/holiday
 * gaps from smooth panning, cursor-anchored zooming, and right-margin whitespace projections.
 */
export class TimeScale {
  private _width = 800;
  private _barSpacing = 8;
  private _rightOffset = 8; // Blank bars of whitespace to the right of baseIndex
  private _baseIndex = 0;

  get width(): number {
    return this._width;
  }

  get barSpacing(): number {
    return this._barSpacing;
  }

  get rightOffset(): number {
    return this._rightOffset;
  }

  get baseIndex(): number {
    return this._baseIndex;
  }

  setWidth(width: number): void {
    this._width = Math.max(1, width);
  }

  setBaseIndex(baseIndex: number): void {
    this._baseIndex = baseIndex;
  }

  setRightOffset(offset: number): void {
    this._rightOffset = offset;
  }

  setBarSpacing(spacing: number): void {
    this._barSpacing = Math.max(MIN_BAR_SPACING, Math.min(MAX_BAR_SPACING, spacing));
  }

  indexToCoordinate(barIndex: number): number {
    const deltaFromRight = this._baseIndex + this._rightOffset - barIndex;
    return this._width - deltaFromRight * this._barSpacing - this._barSpacing * 0.5;
  }

  coordinateToIndex(x: number): number {
    return this._baseIndex + this._rightOffset - (this._width - x - this._barSpacing * 0.5) / this._barSpacing;
  }

  coordinateToLogical(x: number): number {
    return Math.round(this.coordinateToIndex(x));
  }

  getVisibleLogicalRange(firstAvailableIndex: number, lastAvailableIndex: number): {
    from: number;
    to: number;
    rawFrom: number;
    rawTo: number;
  } {
    const rawFrom = this.coordinateToIndex(0);
    const rawTo = this.coordinateToIndex(this._width);
    const from = Math.max(firstAvailableIndex, Math.floor(rawFrom) - 1);
    const to = Math.min(lastAvailableIndex, Math.ceil(rawTo) + 1);
    return { from, to, rawFrom, rawTo };
  }

  scrollByPixels(dx: number, firstAvailableIndex: number): void {
    // Dragging mouse right (+dx) moves chart right -> reveals older bars -> increases rightOffset
    const deltaBars = dx / this._barSpacing;
    this.setRightOffset(this._rightOffset + deltaBars);
    this.clampScroll(firstAvailableIndex);
  }

  /**
   * Cursor-anchored zoom: keeps the exact fractional bar index under anchorX stationary!
   */
  zoomAtCoordinate(anchorX: number, scaleFactor: number, firstAvailableIndex: number): void {
    const clampedX = Math.max(0, Math.min(this._width, anchorX));
    const anchorIdx = this.coordinateToIndex(clampedX);
    const nextSpacing = Math.max(
      MIN_BAR_SPACING,
      Math.min(MAX_BAR_SPACING, this._barSpacing * scaleFactor),
    );
    if (nextSpacing === this._barSpacing) return;

    this._barSpacing = nextSpacing;
    // Solve indexToCoordinate(anchorIdx) === clampedX for rightOffset
    this._rightOffset =
      anchorIdx - this._baseIndex + (this._width - clampedX - this._barSpacing * 0.5) / this._barSpacing;
    this.clampScroll(firstAvailableIndex);
  }

  fitContent(firstIdx: number, lastIdx: number, rightMarginBars = 6): void {
    const count = Math.max(1, lastIdx - firstIdx + 1);
    const desiredSpacing = this._width / (count + rightMarginBars);
    this.setBarSpacing(desiredSpacing);
    this._baseIndex = lastIdx;
    this._rightOffset = rightMarginBars;
  }

  scrollToRealTime(rightMarginBars = 8): void {
    this._rightOffset = rightMarginBars;
  }

  private clampScroll(firstAvailableIndex: number): void {
    const visibleBars = this._width / this._barSpacing;
    // Keep at least 2 bars visible on either edge so users can't lose the chart in infinite void
    const minRightOffset = -Math.max(0, visibleBars - 3);
    const maxRightOffset = Math.max(10, this._baseIndex - firstAvailableIndex + visibleBars - 3);
    this._rightOffset = Math.max(minRightOffset, Math.min(maxRightOffset, this._rightOffset));
  }

  /**
   * Generates non-overlapping hierarchical time axis tick marks (Year > Month > Day > Hour > Minute).
   */
  buildTickMarks(
    firstIdx: number,
    lastIdx: number,
    getTimeAt: (barIndex: number) => number | null,
    timezone: string,
    minTickSpacingPx = 76,
  ): TimeTickMark[] {
    if (firstIdx > lastIdx) return [];

    // Sample candidate indices cleanly when massively zoomed out
    const totalVisible = lastIdx - firstIdx + 1;
    const step = Math.max(1, Math.floor(totalVisible / Math.max(60, this._width / 4)));

    const candidates: TimeTickMark[] = [];
    let prevParts: ReturnType<typeof getLocalParts> | null = null;

    for (let idx = firstIdx; idx <= lastIdx; idx += step) {
      const ts = getTimeAt(idx);
      if (ts === null) continue;
      const x = this.indexToCoordinate(idx);
      if (x < 24 || x > this._width - 24) continue;

      const p = getLocalParts(ts, timezone);
      let weight = 20;
      let label = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
      let bold = false;

      if (!prevParts || p.year !== prevParts.year) {
        weight = 70;
        label = String(p.year);
        bold = true;
      } else if (p.month !== prevParts.month) {
        weight = 60;
        label = MONTHS[p.month - 1] ?? String(p.month);
        bold = true;
      } else if (p.day !== prevParts.day) {
        weight = 50;
        label = `${p.day}`;
        bold = false;
      } else if (p.hour !== prevParts.hour) {
        weight = 40;
        label = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
      } else if (p.minute % 15 === 0) {
        weight = 30;
        label = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
      }

      candidates.push({ barIndex: idx, x, label, weight, bold });
      prevParts = p;
    }

    // Greedy placement in descending weight order so years & months always win
    candidates.sort((a, b) => b.weight - a.weight || a.x - b.x);
    const chosen: TimeTickMark[] = [];
    for (const c of candidates) {
      let overlaps = false;
      for (const existing of chosen) {
        if (Math.abs(existing.x - c.x) < minTickSpacingPx) {
          overlaps = true;
          break;
        }
      }
      if (!overlaps) {
        chosen.push(c);
      }
    }

    chosen.sort((a, b) => a.x - b.x);
    return chosen;
  }
}
