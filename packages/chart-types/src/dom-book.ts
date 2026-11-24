import type { OrderbookDelta, OrderbookLevel } from '@openview/protocol';

export interface DomRow {
  price: number;
  size: number;
  cumulative: number;
}

export interface OrderbookSnapshotView {
  symbol: string;
  sequence: number;
  needsResync: boolean;
  simulated: boolean;
  bids: DomRow[];
  asks: DomRow[];
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  midPrice: number | null;
  imbalanceRatio: number; // 0..1 (>0.5 bid heavy)
}

/**
 * Sequence-Verified L2 Orderbook Delta Engine:
 * Applies snapshots & incremental updates, prunes zero-size levels, and flags sequence gaps
 * so the caller can trigger a clean snapshot resync.
 */
export class OrderbookEngine {
  private readonly symbol: string;
  private readonly bids = new Map<number, number>();
  private readonly asks = new Map<number, number>();
  private lastSequence = 0;
  private needsResync = false;
  private simulated = false;

  constructor(symbol: string) {
    this.symbol = symbol;
  }

  applyDelta(delta: OrderbookDelta, simulated = false): { applied: boolean; needsResync: boolean } {
    this.simulated = simulated;

    if (delta.isSnapshot) {
      this.bids.clear();
      this.asks.clear();
      for (const lv of delta.bids) {
        if (lv.size > 0) this.bids.set(lv.price, lv.size);
      }
      for (const lv of delta.asks) {
        if (lv.size > 0) this.asks.set(lv.price, lv.size);
      }
      this.lastSequence = delta.sequence;
      this.needsResync = false;
      return { applied: true, needsResync: false };
    }

    // Drop stale out-of-order frames
    if (delta.sequence <= this.lastSequence) {
      return { applied: false, needsResync: this.needsResync };
    }

    // Strict sequence gap detection (must be contiguous lastSequence + 1)
    if (this.lastSequence > 0 && delta.sequence !== this.lastSequence + 1) {
      this.needsResync = true;
      return { applied: false, needsResync: true };
    }

    for (const lv of delta.bids) {
      if (lv.size <= 0) this.bids.delete(lv.price);
      else this.bids.set(lv.price, lv.size);
    }
    for (const lv of delta.asks) {
      if (lv.size <= 0) this.asks.delete(lv.price);
      else this.asks.set(lv.price, lv.size);
    }
    this.lastSequence = delta.sequence;
    this.needsResync = false;
    return { applied: true, needsResync: false };
  }

  getView(depth = 12): OrderbookSnapshotView {
    const sortedBids = [...this.bids.entries()]
      .sort((a, b) => b[0] - a[0])
      .slice(0, depth);
    const sortedAsks = [...this.asks.entries()]
      .sort((a, b) => a[0] - b[0])
      .slice(0, depth);

    let cumBid = 0;
    const bids: DomRow[] = sortedBids.map(([price, size]) => {
      cumBid += size;
      return { price, size, cumulative: cumBid };
    });

    let cumAsk = 0;
    const asks: DomRow[] = sortedAsks.map(([price, size]) => {
      cumAsk += size;
      return { price, size, cumulative: cumAsk };
    });

    const bestBid = bids[0]?.price ?? null;
    const bestAsk = asks[0]?.price ?? null;
    const spread = bestBid !== null && bestAsk !== null ? Math.max(0, bestAsk - bestBid) : null;
    const midPrice = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) * 0.5 : null;
    const total = cumBid + cumAsk;

    return {
      symbol: this.symbol,
      sequence: this.lastSequence,
      needsResync: this.needsResync,
      simulated: this.simulated,
      bids,
      asks,
      bestBid,
      bestAsk,
      spread,
      midPrice,
      imbalanceRatio: total > 0 ? cumBid / total : 0.5,
    };
  }
}

/**
 * Generates a deterministic simulated L2 DOM snapshot around a reference price when viewing
 * feeds without native L2 depth (explicitly flagged `simulated: true`).
 */
export function buildSimulatedDomSnapshot(
  symbol: string,
  refPrice: number,
  tickSize: number,
  levels = 12,
  seed = 1,
): OrderbookDelta {
  const step = Math.max(tickSize, refPrice * 0.0001);
  const bids: OrderbookLevel[] = [];
  const asks: OrderbookLevel[] = [];
  for (let i = 1; i <= levels; i++) {
    const jitterA = 1 + Math.sin(seed * 1.7 + i * 0.9) * 0.45;
    const jitterB = 1 + Math.cos(seed * 1.3 + i * 1.1) * 0.45;
    bids.push({
      price: Number((refPrice - i * step).toFixed(6)),
      size: Number((10 * i * Math.max(0.2, jitterA)).toFixed(2)),
    });
    asks.push({
      price: Number((refPrice + i * step).toFixed(6)),
      size: Number((10 * i * Math.max(0.2, jitterB)).toFixed(2)),
    });
  }
  return {
    symbol,
    sequence: seed,
    isSnapshot: true,
    bids,
    asks,
    timestamp: Date.now(),
  };
}
