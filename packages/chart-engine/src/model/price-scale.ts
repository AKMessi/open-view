import type { PriceScaleMode } from '@openview/protocol';

export interface PriceTickMark {
  price: number;
  y: number;
  label: string;
}

export interface PriceScaleConfig {
  mode: PriceScaleMode;
  inverted: boolean;
  tickSize: number;
  precision: number;
  /** Fixed pan-invariant symlog threshold when series crosses <= 0 */
  symlogLinthresh?: number;
  scaleMargins: { top: number; bottom: number };
  currencyPrefix?: string;
}

/**
 * Multi-Mode Vertical Price Axis Engine:
 * - Linear
 * - Pan-Invariant Symmetric Bi-Log (`symlog`): sign(p) * ln(1 + |p| / C)
 *   Never shifts by visibleMin (so trendlines never bend during panning!), safe across p = 0,
 *   and preserves exact logarithmic percentage invariance for all positive instruments.
 * - Percentage (relative to leftmost visible base price)
 * - Indexed to 100
 * - Inverted axis toggle
 */
export class SymlogPriceScale {
  private _height = 400;
  private _topOffset = 0;
  private _minValue = 0;
  private _maxValue = 100;
  private _autoScale = true;
  private _basePrice = 100;
  private _crossesNonPositive = false;
  private config: PriceScaleConfig;

  constructor(config: Partial<PriceScaleConfig> = {}) {
    this.config = {
      mode: config.mode ?? 'linear',
      inverted: config.inverted ?? false,
      tickSize: config.tickSize ?? 0.01,
      precision: config.precision ?? 2,
      scaleMargins: config.scaleMargins ?? { top: 0.1, bottom: 0.1 },
      ...(config.symlogLinthresh !== undefined ? { symlogLinthresh: config.symlogLinthresh } : {}),
      ...(config.currencyPrefix !== undefined ? { currencyPrefix: config.currencyPrefix } : {}),
    };
  }

  get mode(): PriceScaleMode {
    return this.config.mode;
  }

  get inverted(): boolean {
    return this.config.inverted;
  }

  get autoScale(): boolean {
    return this._autoScale;
  }

  get minValue(): number {
    return this._minValue;
  }

  get maxValue(): number {
    return this._maxValue;
  }

  updateConfig(patch: Partial<PriceScaleConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  setMode(mode: PriceScaleMode): void {
    this.config.mode = mode;
  }

  setInverted(inverted: boolean): void {
    this.config.inverted = inverted;
  }

  setAutoScale(enabled: boolean): void {
    this._autoScale = enabled;
  }

  setBasePrice(basePrice: number): void {
    if (Number.isFinite(basePrice) && Math.abs(basePrice) > 1e-12) {
      this._basePrice = basePrice;
    }
  }

  setViewport(topOffset: number, height: number): void {
    this._topOffset = topOffset;
    this._height = Math.max(20, height);
  }

  /**
   * Fixed pan-invariant symlog constant C.
   * For positive instruments: C = max(tickSize, 1e-8) -> ln(1 + p/C) matches ln(p) to 6+ digits.
   * For zero-crossing spreads: C = symlogLinthresh ?? max(100 * tickSize, 1e-4) to prevent extreme
   * visual compression near zero while remaining 100% pan-invariant.
   */
  getSymlogConstant(): number {
    const tick = Math.max(this.config.tickSize, 1e-8);
    if (this._crossesNonPositive) {
      return Math.max(this.config.symlogLinthresh ?? tick * 100, 1e-8);
    }
    return tick;
  }

  private toTransformed(price: number): number {
    switch (this.config.mode) {
      case 'linear':
        return price;
      case 'symlog': {
        const c = this.getSymlogConstant();
        return Math.sign(price) * Math.log(1 + Math.abs(price) / c);
      }
      case 'percentage':
        return ((price - this._basePrice) / this._basePrice) * 100;
      case 'indexed_to_100':
        return (price / this._basePrice) * 100;
    }
  }

  private fromTransformed(val: number): number {
    switch (this.config.mode) {
      case 'linear':
        return val;
      case 'symlog': {
        const c = this.getSymlogConstant();
        return Math.sign(val) * c * Math.expm1(Math.abs(val));
      }
      case 'percentage':
        return this._basePrice * (1 + val / 100);
      case 'indexed_to_100':
        return (val / 100) * this._basePrice;
    }
  }

  /**
   * Update auto-scale vertical bounds from visible data [rawMin, rawMax].
   */
  updateAutoRange(rawMin: number, rawMax: number): void {
    if (!this._autoScale) return;
    if (!Number.isFinite(rawMin) || !Number.isFinite(rawMax)) return;

    if (rawMin <= 0) {
      this._crossesNonPositive = true;
    }

    let minP = rawMin;
    let maxP = rawMax;
    if (Math.abs(maxP - minP) < 1e-12) {
      const pad = Math.max(this.config.tickSize * 10, Math.abs(minP) * 0.01, 1);
      minP -= pad;
      maxP += pad;
    }

    const tMin = this.toTransformed(minP);
    const tMax = this.toTransformed(maxP);
    const tSpan = Math.max(1e-12, tMax - tMin);

    const usableFraction = Math.max(0.1, 1 - this.config.scaleMargins.top - this.config.scaleMargins.bottom);
    const totalTransformedSpan = tSpan / usableFraction;
    const expandedMin = tMin - totalTransformedSpan * this.config.scaleMargins.bottom;
    const expandedMax = tMax + totalTransformedSpan * this.config.scaleMargins.top;

    this._minValue = this.fromTransformed(expandedMin);
    this._maxValue = this.fromTransformed(expandedMax);
  }

  /**
   * Manual vertical drag on price axis: scales range smoothly around viewport midpoint.
   */
  scaleByDrag(dyPixels: number): void {
    this._autoScale = false;
    const tMin = this.toTransformed(this._minValue);
    const tMax = this.toTransformed(this._maxValue);
    const center = (tMin + tMax) * 0.5;
    const halfSpan = Math.max(1e-9, (tMax - tMin) * 0.5);
    const factor = Math.exp((this.config.inverted ? -dyPixels : dyPixels) * 0.005);
    const nextHalf = Math.max(1e-9, Math.min(1e12, halfSpan * factor));
    this._minValue = this.fromTransformed(center - nextHalf);
    this._maxValue = this.fromTransformed(center + nextHalf);
  }

  /**
   * Manual vertical pan when autoScale is disabled.
   */
  panByPixels(dyPixels: number): void {
    if (this._autoScale) return;
    const tMin = this.toTransformed(this._minValue);
    const tMax = this.toTransformed(this._maxValue);
    const tSpan = tMax - tMin;
    const deltaT = ((this.config.inverted ? -dyPixels : dyPixels) / this._height) * tSpan;
    this._minValue = this.fromTransformed(tMin + deltaT);
    this._maxValue = this.fromTransformed(tMax + deltaT);
  }

  priceToCoordinate(price: number): number {
    const tMin = this.toTransformed(this._minValue);
    const tMax = this.toTransformed(this._maxValue);
    const tVal = this.toTransformed(price);
    const span = tMax - tMin;
    if (!Number.isFinite(span) || Math.abs(span) < 1e-15) {
      return this._topOffset + this._height * 0.5;
    }
    const norm = (tVal - tMin) / span; // 0 at bottom, 1 at top (normal mode)
    const yRel = this.config.inverted ? norm * this._height : (1 - norm) * this._height;
    return this._topOffset + yRel;
  }

  coordinateToPrice(y: number): number {
    const tMin = this.toTransformed(this._minValue);
    const tMax = this.toTransformed(this._maxValue);
    const span = tMax - tMin;
    const yRel = y - this._topOffset;
    const norm = this.config.inverted ? yRel / this._height : 1 - yRel / this._height;
    return this.fromTransformed(tMin + norm * span);
  }

  formatPrice(price: number): string {
    if (!Number.isFinite(price)) return '—';
    if (this.config.mode === 'percentage') {
      const pct = ((price - this._basePrice) / this._basePrice) * 100;
      return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
    }
    if (this.config.mode === 'indexed_to_100') {
      const idx = (price / this._basePrice) * 100;
      return idx.toFixed(2);
    }
    const quantized = Math.round(price / this.config.tickSize) * this.config.tickSize;
    const formatted = quantized.toFixed(this.config.precision);
    return this.config.currencyPrefix ? `${this.config.currencyPrefix}${formatted}` : formatted;
  }

  buildTickMarks(minSpacingPx = 38): PriceTickMark[] {
    const maxTicks = Math.max(2, Math.floor(this._height / minSpacingPx));
    const displayMin =
      this.config.mode === 'percentage'
        ? ((this._minValue - this._basePrice) / this._basePrice) * 100
        : this.config.mode === 'indexed_to_100'
          ? (this._minValue / this._basePrice) * 100
          : this._minValue;
    const displayMax =
      this.config.mode === 'percentage'
        ? ((this._maxValue - this._basePrice) / this._basePrice) * 100
        : this.config.mode === 'indexed_to_100'
          ? (this._maxValue / this._basePrice) * 100
          : this._maxValue;

    const span = Math.abs(displayMax - displayMin);
    if (!Number.isFinite(span) || span <= 0) return [];

    const rawStep = span / maxTicks;
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const residual = rawStep / mag;
    let niceMult = 1;
    if (residual > 5) niceMult = 10;
    else if (residual > 2.5) niceMult = 5;
    else if (residual > 2) niceMult = 2.5;
    else if (residual > 1) niceMult = 2;

    let step = niceMult * mag;
    if (this.config.mode === 'linear' || this.config.mode === 'symlog') {
      step = Math.max(this.config.tickSize, Math.round(step / this.config.tickSize) * this.config.tickSize);
    }

    const start = Math.ceil(Math.min(displayMin, displayMax) / step) * step;
    const end = Math.max(displayMin, displayMax);
    const ticks: PriceTickMark[] = [];
    let lastY = -Infinity;

    for (let v = start; v <= end + step * 0.001 && ticks.length < 40; v += step) {
      const price =
        this.config.mode === 'percentage'
          ? this._basePrice * (1 + v / 100)
          : this.config.mode === 'indexed_to_100'
            ? (v / 100) * this._basePrice
            : v;
      const y = this.priceToCoordinate(price);
      if (y < this._topOffset + 12 || y > this._topOffset + this._height - 12) continue;
      if (Math.abs(y - lastY) < minSpacingPx * 0.72) continue;
      ticks.push({
        price,
        y,
        label: this.formatPrice(price),
      });
      lastY = y;
    }

    return ticks;
  }
}
