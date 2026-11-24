import { describe, expect, it } from 'vitest';
import type { OHLCVBar } from '@openview/protocol';
import {
  OrderbookEngine,
  buildHistoricalIntrabarFootprint,
  buildKagiBars,
  buildLineBreakBars,
  buildLiveTickFootprint,
  buildPointAndFigureBars,
  buildRangeBars,
  buildRenkoBars,
  buildSimulatedDomSnapshot,
  buildTpoProfile,
  buildVolumeProfile,
  evaluateSpreadBars,
  parseSpreadExpression,
} from './index.ts';

function makeVolatileSeries(count = 200, start = 100, stepScale = 1.5): OHLCVBar[] {
  const out: OHLCVBar[] = [];
  let p = start;
  const baseTime = Date.UTC(2026, 0, 5, 9, 15, 0);
  for (let i = 0; i < count; i++) {
    const open = p;
    const wave = Math.sin(i * 0.17) * stepScale * 2.2 + Math.cos(i * 0.05) * stepScale;
    const close = Math.max(10, open + wave);
    const high = Math.max(open, close) + stepScale * 1.4;
    const low = Math.max(1, Math.min(open, close) - stepScale * 1.3);
    out.push({
      time: baseTime + i * 60_000,
      open,
      high,
      low,
      close,
      volume: 500 + (i % 7) * 120,
    });
    p = close;
  }
  return out;
}

describe('Phase 7 — Non-Time Charts, Dual-Mode Orderflow, Synthetic Spreads & L2 DOM', () => {
  it('emits duplicate-timestamp Renko bricks and conserves Range bar bounds', () => {
    const baseTime = Date.UTC(2026, 0, 5, 9, 15, 0);
    // Single huge volatile 1m bar that should emit multiple identical-timestamp bricks
    const bars: OHLCVBar[] = [
      { time: baseTime, open: 100, high: 101, low: 99, close: 100, volume: 100 },
      { time: baseTime + 60_000, open: 100, high: 115, low: 100, close: 115, volume: 600 },
      { time: baseTime + 120_000, open: 115, high: 115, low: 100, close: 100, volume: 500 },
    ];

    const renko = buildRenkoBars(bars, { mode: 'fixed', brickSize: 2 });
    expect(renko.length).toBeGreaterThanOrEqual(8);
    // Multiple bricks share the exact timestamp of the volatile 1m bar
    const sameTimeBricks = renko.filter((b) => b.time === baseTime + 60_000);
    expect(sameTimeBricks.length).toBeGreaterThan(3);
    for (const brick of renko) {
      expect(Math.abs(brick.high - brick.low - 2)).toBeLessThan(1e-9);
    }

    const range = buildRangeBars(bars, 3);
    expect(range.length).toBeGreaterThan(4);
    for (const rb of range.slice(0, -1)) {
      expect(Math.abs(rb.high - rb.low - 3)).toBeLessThan(1e-9);
    }

    const series = makeVolatileSeries(160);
    expect(buildKagiBars(series, 4).length).toBeGreaterThan(2);
    expect(buildPointAndFigureBars(series, 2, 3).length).toBeGreaterThan(2);
    expect(buildLineBreakBars(series, 3).length).toBeGreaterThan(5);
  });

  it('conserves 100% of NSE coalesced volumeTradedToday deltas in Mode A Footprint and flags Mode B as approximate', () => {
    const t0 = Date.UTC(2026, 0, 5, 9, 15, 0);
    const packets = [
      { price: 100.0, timestamp: t0, volumeTradedToday: 1000, bestBid: 99.95, bestAsk: 100.05 },
      { price: 100.05, timestamp: t0 + 1000, volumeTradedToday: 1350, bestBid: 100.0, bestAsk: 100.05 }, // +350 buy
      { price: 100.1, timestamp: t0 + 2000, volumeTradedToday: 1950, bestBid: 100.05, bestAsk: 100.1 }, // +600 buy
      { price: 99.95, timestamp: t0 + 3000, volumeTradedToday: 2200, bestBid: 99.95, bestAsk: 100.0 }, // +250 sell
      { price: 100.05, timestamp: t0 + 4000, volumeTradedToday: 2600, bestBid: 100.0, bestAsk: 100.05 }, // +400 buy
    ];
    const expectedTotalDelta = 2600 - 1000;

    const liveFp = buildLiveTickFootprint(packets, 60_000, 0.05);
    expect(liveFp).toHaveLength(1);
    expect(liveFp[0]!.mode).toBe('live_tick');
    expect(liveFp[0]!.approximate).toBe(false);
    expect(liveFp[0]!.totalVolume).toBe(expectedTotalDelta);

    const rowSum = liveFp[0]!.rows.reduce((acc, r) => acc + r.bidVol + r.askVol, 0);
    expect(rowSum).toBe(expectedTotalDelta);
    // Buy volume (350 + 600 + 400 = 1350) - Sell volume (250) = +1100
    expect(liveFp[0]!.barDelta).toBe(1100);

    const histFp = buildHistoricalIntrabarFootprint(makeVolatileSeries(15), 1.0);
    expect(histFp).toHaveLength(15);
    expect(histFp[0]!.mode).toBe('intrabar_1m');
    expect(histFp[0]!.approximate).toBe(true);
  });

  it('computes Volume Profile POC/VAH/VAL and TPO Market Profile Initial Balance & Single Prints', () => {
    const series = makeVolatileSeries(120, 200, 1.2);
    const vp = buildVolumeProfile(series, 24);
    expect(vp.rows).toHaveLength(24);
    expect(vp.val).toBeLessThanOrEqual(vp.pocPrice);
    expect(vp.pocPrice).toBeLessThanOrEqual(vp.vah);
    expect(vp.totalVolume).toBeGreaterThan(0);

    const tpo = buildTpoProfile(series, 1.0, 30 * 60_000);
    expect(tpo.rows.length).toBeGreaterThan(3);
    expect(tpo.ibHigh).toBeGreaterThan(tpo.ibLow);
    expect(tpo.val).toBeLessThanOrEqual(tpo.pocPrice);
    expect(tpo.pocPrice).toBeLessThanOrEqual(tpo.vah);
  });

  it('evaluates Synthetic Spread expressions with clamped non-inverted wicks under inner_join and ffill', () => {
    const parsed = parseSpreadExpression('FX:XAUUSD / FX:XAGUSD');
    expect(parsed.symbols).toEqual(['FX:XAUUSD', 'FX:XAGUSD']);

    const gold = makeVolatileSeries(500, 2650, 6.0);
    const silver = makeVolatileSeries(500, 31.5, 0.35);
    // Drop 20 silver timestamps to verify inner_join vs ffill behavior
    const silverGapped = silver.filter((_, idx) => idx % 25 !== 10);

    const inner = evaluateSpreadBars(
      'FX:XAUUSD / FX:XAGUSD',
      { 'FX:XAUUSD': gold, 'FX:XAGUSD': silverGapped },
      'inner_join',
    );
    const ffilled = evaluateSpreadBars(
      'FX:XAUUSD / FX:XAGUSD',
      { 'FX:XAUUSD': gold, 'FX:XAGUSD': silverGapped },
      'ffill',
    );

    expect(inner.length).toBe(silverGapped.length);
    expect(ffilled.length).toBe(gold.length);

    // Property invariant: EVERY synthetic bar must satisfy high >= max(O, C) and low <= min(O, C)
    for (const b of ffilled) {
      expect(Number.isFinite(b.open)).toBe(true);
      expect(Number.isFinite(b.close)).toBe(true);
      expect(b.high).toBeGreaterThanOrEqual(Math.max(b.open, b.close) - 1e-12);
      expect(b.low).toBeLessThanOrEqual(Math.min(b.open, b.close) + 1e-12);
      expect(b.high).toBeGreaterThanOrEqual(b.low);
    }

    const linear = evaluateSpreadBars(
      '2 * A - B',
      { A: gold.slice(0, 50), B: silver.slice(0, 50) },
      'inner_join',
    );
    expect(linear).toHaveLength(50);
    expect(linear[0]!.close).toBeCloseTo(2 * gold[0]!.close - silver[0]!.close, 6);
  });

  it('enforces L2 OrderbookEngine sequence continuity, zero-size pruning & gap resync flagging', () => {
    const ob = new OrderbookEngine('BINANCE:BTCUSDT');
    const snap = buildSimulatedDomSnapshot('BINANCE:BTCUSDT', 95_000, 0.5, 8, 10);
    expect(ob.applyDelta(snap)).toEqual({ applied: true, needsResync: false });

    const view1 = ob.getView(8);
    expect(view1.bestBid).toBeLessThan(view1.bestAsk!);
    expect(view1.spread).toBeGreaterThan(0);

    // Contiguous delta (seq 11) removes bestBid
    const removedBid = view1.bestBid!;
    const res11 = ob.applyDelta({
      symbol: 'BINANCE:BTCUSDT',
      sequence: 11,
      isSnapshot: false,
      bids: [{ price: removedBid, size: 0 }],
      asks: [],
      timestamp: Date.now(),
    });
    expect(res11).toEqual({ applied: true, needsResync: false });
    expect(ob.getView(8).bestBid).toBeLessThan(removedBid);

    // Sequence gap (seq 15 instead of 12) triggers needsResync
    const resGap = ob.applyDelta({
      symbol: 'BINANCE:BTCUSDT',
      sequence: 15,
      isSnapshot: false,
      bids: [{ price: 94_990, size: 5 }],
      asks: [],
      timestamp: Date.now(),
    });
    expect(resGap).toEqual({ applied: false, needsResync: true });
    expect(ob.getView(8).needsResync).toBe(true);
  });
});
