import type { OHLCVBar, TradeTick } from '@openview/protocol';

export type FootprintMode = 'live_tick' | 'intrabar_1m';

export interface FootprintRow {
  price: number;
  bidVol: number;
  askVol: number;
  totalVol: number;
  delta: number;
  buyImbalance: boolean;
  sellImbalance: boolean;
}

export interface FootprintBar {
  time: number;
  mode: FootprintMode;
  approximate: boolean;
  rows: FootprintRow[];
  pocPrice: number;
  vah: number;
  val: number;
  totalVolume: number;
  barDelta: number;
  cumDelta: number;
  stackedBuyImbalances: number;
  stackedSellImbalances: number;
}

/**
 * NSE / Coalesced-Tick Packet for Mode A Live Footprint:
 * Uses cumulative session `volumeTradedToday` deltas so multi-trade snapshots conserve 100% of volume!
 */
export interface CoalescedTickPacket {
  price: number;
  timestamp: number;
  /** Optional raw trade size if stream provides per-trade size (Binance aggTrade) */
  size?: number;
  /** Optional explicit aggressor side */
  side?: 'buy' | 'sell' | 'unknown';
  /** Cumulative session volume traded today (Indian NSE / MCX broker feeds) */
  volumeTradedToday?: number;
  bestBid?: number;
  bestAsk?: number;
}

function quantizePrice(price: number, step: number): number {
  return Number((Math.round(price / step) * step).toFixed(8));
}

function computeValueArea(
  rows: readonly { price: number; totalVol: number }[],
  valueAreaRatio = 0.7,
): { pocPrice: number; vah: number; val: number } {
  if (rows.length === 0) return { pocPrice: 0, vah: 0, val: 0 };
  const sorted = [...rows].sort((a, b) => a.price - b.price);
  let pocIdx = 0;
  let totalVol = 0;
  for (let i = 0; i < sorted.length; i++) {
    totalVol += sorted[i]!.totalVol;
    if (sorted[i]!.totalVol > sorted[pocIdx]!.totalVol) pocIdx = i;
  }

  const target = totalVol * valueAreaRatio;
  let acc = sorted[pocIdx]!.totalVol;
  let lo = pocIdx;
  let hi = pocIdx;

  while (acc < target && (lo > 0 || hi < sorted.length - 1)) {
    const upVol = hi + 1 < sorted.length ? sorted[hi + 1]!.totalVol : -1;
    const dnVol = lo - 1 >= 0 ? sorted[lo - 1]!.totalVol : -1;
    if (upVol >= dnVol && hi + 1 < sorted.length) {
      hi++;
      acc += sorted[hi]!.totalVol;
    } else if (lo - 1 >= 0) {
      lo--;
      acc += sorted[lo]!.totalVol;
    } else {
      break;
    }
  }

  return {
    pocPrice: sorted[pocIdx]!.price,
    val: sorted[lo]!.price,
    vah: sorted[hi]!.price,
  };
}

function finalizeFootprintRows(
  buckets: Map<number, { bidVol: number; askVol: number }>,
  imbalanceRatio = 3.0,
): {
  rows: FootprintRow[];
  pocPrice: number;
  vah: number;
  val: number;
  totalVolume: number;
  barDelta: number;
  stackedBuyImbalances: number;
  stackedSellImbalances: number;
} {
  const prices = [...buckets.keys()].sort((a, b) => a - b);
  const rows: FootprintRow[] = prices.map((price) => {
    const b = buckets.get(price)!;
    return {
      price,
      bidVol: b.bidVol,
      askVol: b.askVol,
      totalVol: b.bidVol + b.askVol,
      delta: b.askVol - b.bidVol,
      buyImbalance: false,
      sellImbalance: false,
    };
  });

  // Diagonal imbalances: Ask[i] vs Bid[i - 1] (buying), Bid[i] vs Ask[i + 1] (selling)
  for (let i = 0; i < rows.length; i++) {
    if (i > 0) {
      const belowBid = rows[i - 1]!.bidVol;
      if (rows[i]!.askVol > 0 && (belowBid === 0 || rows[i]!.askVol >= belowBid * imbalanceRatio)) {
        rows[i]!.buyImbalance = true;
      }
    }
    if (i + 1 < rows.length) {
      const aboveAsk = rows[i + 1]!.askVol;
      if (rows[i]!.bidVol > 0 && (aboveAsk === 0 || rows[i]!.bidVol >= aboveAsk * imbalanceRatio)) {
        rows[i]!.sellImbalance = true;
      }
    }
  }

  let maxBuyStack = 0;
  let curBuy = 0;
  let maxSellStack = 0;
  let curSell = 0;
  let totalVolume = 0;
  let barDelta = 0;
  for (const r of rows) {
    totalVolume += r.totalVol;
    barDelta += r.delta;
    if (r.buyImbalance) { curBuy++; maxBuyStack = Math.max(maxBuyStack, curBuy); } else curBuy = 0;
    if (r.sellImbalance) { curSell++; maxSellStack = Math.max(maxSellStack, curSell); } else curSell = 0;
  }

  const va = computeValueArea(rows);
  return {
    rows,
    ...va,
    totalVolume,
    barDelta,
    stackedBuyImbalances: maxBuyStack,
    stackedSellImbalances: maxSellStack,
  };
}

/**
 * Mode A — Live Tick / Coalesced-Packet Footprint Engine:
 * Supports both Binance `aggTrade` (per-trade size + aggressor) AND Indian NSE/MCX
 * coalesced quote packets (`volumeTradedToday` delta + Lee-Ready mid-quote/tick test),
 * strictly conserving `sum(bidVol + askVol) === totalSessionDelta`.
 */
export function buildLiveTickFootprint(
  packets: readonly (CoalescedTickPacket | TradeTick)[],
  barDurationMs: number,
  priceStep: number,
  imbalanceRatio = 3.0,
): FootprintBar[] {
  if (packets.length === 0 || priceStep <= 0) return [];
  const barBuckets = new Map<number, Map<number, { bidVol: number; askVol: number }>>();

  let prevVtt: number | undefined;
  let prevPrice: number | undefined;
  let lastSide: 'buy' | 'sell' = 'buy';

  for (const pkt of packets) {
    let deltaVol = 0;
    if ('volumeTradedToday' in pkt && typeof pkt.volumeTradedToday === 'number') {
      if (prevVtt === undefined) {
        prevVtt = pkt.volumeTradedToday;
        prevPrice = pkt.price;
        continue;
      }
      deltaVol = Math.max(0, pkt.volumeTradedToday - prevVtt);
      prevVtt = pkt.volumeTradedToday;
    } else if (typeof pkt.size === 'number') {
      deltaVol = Math.max(0, pkt.size);
    }
    if (deltaVol <= 0) {
      prevPrice = pkt.price;
      continue;
    }

    // Lee-Ready Trade Classification
    let side: 'buy' | 'sell' = lastSide;
    if (pkt.side === 'buy' || pkt.side === 'sell') {
      side = pkt.side;
    } else if ('bestBid' in pkt && 'bestAsk' in pkt && pkt.bestBid !== undefined && pkt.bestAsk !== undefined) {
      const mid = (pkt.bestBid + pkt.bestAsk) * 0.5;
      if (pkt.price > mid) side = 'buy';
      else if (pkt.price < mid) side = 'sell';
      else if (prevPrice !== undefined && pkt.price !== prevPrice) {
        side = pkt.price > prevPrice ? 'buy' : 'sell';
      }
    } else if (prevPrice !== undefined && pkt.price !== prevPrice) {
      side = pkt.price > prevPrice ? 'buy' : 'sell';
    }
    lastSide = side;
    prevPrice = pkt.price;

    const bucketTime = Math.floor(pkt.timestamp / barDurationMs) * barDurationMs;
    let rowsMap = barBuckets.get(bucketTime);
    if (!rowsMap) {
      rowsMap = new Map();
      barBuckets.set(bucketTime, rowsMap);
    }

    const level = quantizePrice(pkt.price, priceStep);
    const cur = rowsMap.get(level) ?? { bidVol: 0, askVol: 0 };
    if (side === 'buy') cur.askVol += deltaVol;
    else cur.bidVol += deltaVol;
    rowsMap.set(level, cur);
  }

  const times = [...barBuckets.keys()].sort((a, b) => a - b);
  let cumDelta = 0;
  return times.map((time) => {
    const fin = finalizeFootprintRows(barBuckets.get(time)!, imbalanceRatio);
    cumDelta += fin.barDelta;
    return {
      time,
      mode: 'live_tick',
      approximate: false,
      ...fin,
      cumDelta,
    };
  });
}

/**
 * Mode B — Historical 1m-Intrabar Profile Footprint:
 * Clearly flags `mode: 'intrabar_1m'` and `approximate: true` so users never confuse
 * historical OHLCV profile approximations with exchange tick-by-tick orderflow.
 */
export function buildHistoricalIntrabarFootprint(
  bars: readonly OHLCVBar[],
  priceStep: number,
  imbalanceRatio = 3.0,
): FootprintBar[] {
  if (bars.length === 0 || priceStep <= 0) return [];
  let cumDelta = 0;

  return bars.map((bar) => {
    const buckets = new Map<number, { bidVol: number; askVol: number }>();
    const loLvl = quantizePrice(bar.low, priceStep);
    const hiLvl = quantizePrice(bar.high, priceStep);
    const steps = Math.max(1, Math.min(40, Math.round((hiLvl - loLvl) / priceStep) + 1));
    const buyRatio =
      bar.high > bar.low
        ? Math.min(0.85, Math.max(0.15, (bar.close - bar.low) / (bar.high - bar.low)))
        : bar.close >= bar.open
          ? 0.6
          : 0.4;
    const volPerRow = bar.volume / steps;

    for (let i = 0; i < steps; i++) {
      const price = quantizePrice(loLvl + i * priceStep, priceStep);
      const frac = steps > 1 ? i / (steps - 1) : 0.5;
      // Weight buying pressure slightly toward upper ticks on bullish bars
      const localBuy = Math.min(0.95, Math.max(0.05, buyRatio * (0.85 + 0.3 * frac)));
      buckets.set(price, {
        askVol: volPerRow * localBuy,
        bidVol: volPerRow * (1 - localBuy),
      });
    }

    const fin = finalizeFootprintRows(buckets, imbalanceRatio);
    cumDelta += fin.barDelta;
    return {
      time: bar.time,
      mode: 'intrabar_1m',
      approximate: true,
      ...fin,
      cumDelta,
    };
  });
}

export interface VolumeProfileRow {
  price: number;
  priceLow: number;
  priceHigh: number;
  upVol: number;
  downVol: number;
  totalVol: number;
}

export interface VolumeProfileResult {
  rows: VolumeProfileRow[];
  pocPrice: number;
  vah: number;
  val: number;
  maxRowVol: number;
  totalVolume: number;
}

/**
 * Volume Profile Engine (VRVP / SVP / FRVP):
 * Distributes bar volume across price bins and computes exact POC + 70% Value Area.
 */
export function buildVolumeProfile(
  bars: readonly OHLCVBar[],
  rowCount = 32,
  valueAreaRatio = 0.7,
): VolumeProfileResult {
  if (bars.length === 0) {
    return { rows: [], pocPrice: 0, vah: 0, val: 0, maxRowVol: 0, totalVolume: 0 };
  }

  let minP = Infinity;
  let maxP = -Infinity;
  for (const b of bars) {
    if (b.low < minP) minP = b.low;
    if (b.high > maxP) maxP = b.high;
  }
  if (!Number.isFinite(minP) || !Number.isFinite(maxP)) {
    return { rows: [], pocPrice: 0, vah: 0, val: 0, maxRowVol: 0, totalVolume: 0 };
  }
  if (maxP <= minP) maxP = minP + 1e-6;

  const bins = Math.max(6, Math.min(120, Math.floor(rowCount)));
  const binSize = (maxP - minP) / bins;
  const rows: VolumeProfileRow[] = Array.from({ length: bins }, (_, i) => ({
    priceLow: minP + i * binSize,
    priceHigh: minP + (i + 1) * binSize,
    price: minP + (i + 0.5) * binSize,
    upVol: 0,
    downVol: 0,
    totalVol: 0,
  }));

  let totalVolume = 0;
  for (const b of bars) {
    const vol = b.volume > 0 ? b.volume : 1; // fallback unit weight on zero-volume spot indices
    totalVolume += vol;
    const isUp = b.close >= b.open;
    const startBin = Math.max(0, Math.min(bins - 1, Math.floor((b.low - minP) / binSize)));
    const endBin = Math.max(startBin, Math.min(bins - 1, Math.floor((b.high - minP) / binSize)));
    const span = endBin - startBin + 1;
    const perBin = vol / span;
    for (let i = startBin; i <= endBin; i++) {
      if (isUp) rows[i]!.upVol += perBin;
      else rows[i]!.downVol += perBin;
      rows[i]!.totalVol += perBin;
    }
  }

  let maxRowVol = 0;
  for (const r of rows) {
    if (r.totalVol > maxRowVol) maxRowVol = r.totalVol;
  }
  const va = computeValueArea(rows, valueAreaRatio);

  return {
    rows,
    ...va,
    maxRowVol,
    totalVolume,
  };
}

export interface TpoRow {
  price: number;
  letters: string[];
  count: number;
  isSinglePrint: boolean;
}

export interface TpoProfileResult {
  rows: TpoRow[];
  pocPrice: number;
  vah: number;
  val: number;
  ibHigh: number;
  ibLow: number;
  singlePrintPrices: number[];
}

const TPO_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * TPO (Time Price Opportunity) Market Profile Engine:
 * Groups bars into 30-minute lettered periods (A, B, C...), extracts Initial Balance (A+B),
 * POC, 70% Value Area, and interior Single Prints.
 */
export function buildTpoProfile(
  bars: readonly OHLCVBar[],
  tickStep?: number,
  periodMs = 30 * 60_000,
): TpoProfileResult {
  if (bars.length === 0) {
    return { rows: [], pocPrice: 0, vah: 0, val: 0, ibHigh: 0, ibLow: 0, singlePrintPrices: [] };
  }

  let minP = Infinity;
  let maxP = -Infinity;
  for (const b of bars) {
    if (b.low < minP) minP = b.low;
    if (b.high > maxP) maxP = b.high;
  }
  const step = tickStep && tickStep > 0 ? tickStep : Math.max(1e-6, (maxP - minP) / 24);
  const startTime = bars[0]!.time;
  const priceMap = new Map<number, Set<string>>();

  let ibHigh = -Infinity;
  let ibLow = Infinity;

  for (const b of bars) {
    const periodIdx = Math.max(0, Math.floor((b.time - startTime) / periodMs));
    const letter = TPO_LETTERS[periodIdx % TPO_LETTERS.length]!;
    if (periodIdx <= 1) {
      if (b.high > ibHigh) ibHigh = b.high;
      if (b.low < ibLow) ibLow = b.low;
    }

    const lo = quantizePrice(b.low, step);
    const hi = quantizePrice(b.high, step);
    const count = Math.max(1, Math.min(80, Math.round((hi - lo) / step) + 1));
    for (let i = 0; i < count; i++) {
      const p = quantizePrice(lo + i * step, step);
      let set = priceMap.get(p);
      if (!set) {
        set = new Set();
        priceMap.set(p, set);
      }
      set.add(letter);
    }
  }

  const sortedPrices = [...priceMap.keys()].sort((a, b) => a - b);
  const rows: TpoRow[] = sortedPrices.map((price, idx) => {
    const letters = [...priceMap.get(price)!];
    const isInterior = idx > 0 && idx < sortedPrices.length - 1;
    return {
      price,
      letters,
      count: letters.length,
      isSinglePrint: isInterior && letters.length === 1,
    };
  });

  const va = computeValueArea(
    rows.map((r) => ({ price: r.price, totalVol: r.count })),
    0.7,
  );

  return {
    rows,
    ...va,
    ibHigh: Number.isFinite(ibHigh) ? ibHigh : maxP,
    ibLow: Number.isFinite(ibLow) ? ibLow : minP,
    singlePrintPrices: rows.filter((r) => r.isSinglePrint).map((r) => r.price),
  };
}
