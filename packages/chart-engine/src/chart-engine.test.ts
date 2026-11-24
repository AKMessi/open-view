import { describe, expect, it } from 'vitest';
import {
  computeCandleBitmapMetrics,
  DEMO_SYMBOLS,
  generateSyntheticBars,
  getLocalParts,
  MipmapPlotList,
  PaneLayoutSolver,
  SessionCalendar,
  SymlogPriceScale,
  TimeScale,
} from './index.ts';

describe('Phase 1 — Clean-Room Chart Engine Core Invariants', () => {
  it('supports O(1) negative-index left-scroll prepend and duplicate timestamps (Renko/Range)', () => {
    const plot = new MipmapPlotList();
    plot.setBars([
      { time: 1000, open: 10, high: 12, low: 9, close: 11, volume: 100 },
      { time: 2000, open: 11, high: 13, low: 10, close: 12, volume: 200 },
    ]);

    // Prepend 3 older bars -> indices -3, -2, -1 while original bars stay at 0, 1!
    plot.prependBars([
      { time: 700, open: 7, high: 8, low: 6, close: 7.5, volume: 50 },
      { time: 800, open: 7.5, high: 9, low: 7, close: 8.5, volume: 60 },
      { time: 900, open: 8.5, high: 10, low: 8, close: 10, volume: 70 },
    ]);

    expect(plot.firstIndex()).toBe(-3);
    expect(plot.lastIndex()).toBe(1);
    expect(plot.getBar(-3)?.time).toBe(700);
    expect(plot.getBar(0)?.time).toBe(1000);
    expect(plot.getBar(1)?.close).toBe(12);

    // Duplicate timestamps allowed for non-time charts (e.g. multiple Renko bricks in 1m)
    const r1 = plot.upsertBar({ time: 2000, open: 12, high: 14, low: 12, close: 14, volume: 90 }, true);
    expect(r1.appended).toBe(true);
    expect(r1.barIndex).toBe(2);
    expect(plot.getBar(1)?.time).toBe(2000);
    expect(plot.getBar(2)?.time).toBe(2000);
  });

  it('provides pan-invariant power-of-2 mipmaps and queries 250,000 bars in < 2.5ms', () => {
    const bars = generateSyntheticBars(DEMO_SYMBOLS['BINANCE:BTCUSDT']!, '1', 250_000, 77);
    const plot = new MipmapPlotList();
    plot.setBars(bars);

    // Warm up mipmap build once on data load
    const warmup = plot.forEachVisible(0, 249_999, 0.005, false, () => {});
    expect(warmup.levelStride).toBe(128);
    expect(warmup.drawnCount).toBeLessThan(2100);

    // Verify pan invariance: shifting viewport by 1 bar does not change bucket bounds for interior buckets
    const bucketsA: number[] = [];
    plot.forEachVisible(1000, 50_000, 0.02, false, (bIdx) => bucketsA.push(bIdx));
    const bucketsB: number[] = [];
    plot.forEachVisible(1001, 50_001, 0.02, false, (bIdx) => bucketsB.push(bIdx));
    // Every shared interior bucket must start on the exact same index (zero pan shimmer!)
    expect(bucketsA[5]).toBe(bucketsB[5]);

    // Performance gate: 50 consecutive panned frames across 250,000 bars
    const times: number[] = [];
    for (let f = 0; f < 50; f++) {
      const t0 = performance.now();
      let drawn = 0;
      plot.getPriceBounds(f * 100, 240_000 + f * 100, 0.005, false);
      plot.forEachVisible(f * 100, 240_000 + f * 100, 0.005, false, () => {
        drawn++;
      });
      times.push(performance.now() - t0);
      expect(drawn).toBeGreaterThan(1000);
    }
    times.sort((a, b) => a - b);
    const medianMs = times[Math.floor(times.length / 2)]!;
    expect(medianMs).toBeLessThan(2.5);
  });

  it('maintains exact bidirectional TimeScale transforms and cursor-anchored zoom', () => {
    const ts = new TimeScale();
    ts.setWidth(1000);
    ts.setBaseIndex(500);
    ts.setBarSpacing(10);
    ts.setRightOffset(5);

    for (const idx of [0, 125, 450, 500, 504]) {
      const x = ts.indexToCoordinate(idx);
      expect(ts.coordinateToIndex(x)).toBeCloseTo(idx, 10);
    }

    // Cursor-anchored zoom at x = 350 must keep the exact fractional barIndex under 350 stationary
    const beforeIdx = ts.coordinateToIndex(350);
    ts.zoomAtCoordinate(350, 1.5, 0);
    const afterIdx = ts.coordinateToIndex(350);
    expect(afterIdx).toBeCloseTo(beforeIdx, 8);

    // Direct-manipulation pan polarity:
    // Dragging mouse LEFT (dx = -100) moves grabbed bar LEFT by 100px (taking viewport RIGHT)
    const bar450Before = ts.indexToCoordinate(450);
    ts.scrollByPixels(-100, 0);
    expect(ts.indexToCoordinate(450)).toBeCloseTo(bar450Before - 100, 8);

    // Dragging mouse RIGHT (dx = +100) returns grabbed bar RIGHT by 100px (revealing older left history)
    ts.scrollByPixels(100, 0);
    expect(ts.indexToCoordinate(450)).toBeCloseTo(bar450Before, 8);

    // Full history scrollability: dragging right reaches bar 0 smoothly
    ts.scrollByPixels(10_000, 0);
    const vis = ts.getVisibleLogicalRange(0, 500);
    expect(vis.from).toBe(0);
  });

  it('maintains pan-invariant SymlogPriceScale across positive & zero-crossing negative spreads', () => {
    const posScale = new SymlogPriceScale({ mode: 'symlog', tickSize: 0.01, precision: 2 });
    posScale.setViewport(0, 500);
    posScale.updateAutoRange(50_000, 100_000);

    // Bidirectional accuracy
    for (const p of [50_000, 68_420.5, 99_999.99]) {
      expect(posScale.coordinateToPrice(posScale.priceToCoordinate(p))).toBeCloseTo(p, 5);
    }

    // Exact logarithmic percentage invariance: doubling 25k->50k equals 50k->100k in pixels
    posScale.updateAutoRange(25_000, 100_000);
    const dy1 = Math.abs(posScale.priceToCoordinate(50_000) - posScale.priceToCoordinate(25_000));
    const dy2 = Math.abs(posScale.priceToCoordinate(100_000) - posScale.priceToCoordinate(50_000));
    expect(dy1).toBeCloseTo(dy2, 2);

    // Zero-crossing spread: smooth, non-NaN, exact round-trip across -50..0..+50
    const spreadScale = new SymlogPriceScale({ mode: 'symlog', tickSize: 0.01, precision: 2 });
    spreadScale.setViewport(0, 500);
    spreadScale.updateAutoRange(-50, 50);
    for (const p of [-42.5, -1.25, 0, 1.25, 42.5]) {
      const y = spreadScale.priceToCoordinate(p);
      expect(Number.isFinite(y)).toBe(true);
      expect(spreadScale.coordinateToPrice(y)).toBeCloseTo(p, 5);
    }
  });

  it('anchors Indian NSE 1H candles to 09:15 IST with hard 15:30 close and Muhurat overrides', () => {
    const cal = new SessionCalendar();

    // 2026-07-15 10:20 IST = 04:50 UTC -> must bucket into 10:15..11:15 IST (04:45..05:45 UTC)!
    const sampleIst1020 = Date.UTC(2026, 6, 15, 4, 50, 0);
    const b1h = cal.bucketBarTimestamp(sampleIst1020, '60', 'NSE');
    const openParts = getLocalParts(b1h.openTime, 'Asia/Kolkata');
    const closeParts = getLocalParts(b1h.closeTime, 'Asia/Kolkata');
    expect(`${openParts.hour}:${String(openParts.minute).padStart(2, '0')}`).toBe('10:15');
    expect(`${closeParts.hour}:${String(closeParts.minute).padStart(2, '0')}`).toBe('11:15');

    // Closing stub 15:20 IST (09:50 UTC) -> opens 15:15 IST, hard-closes at 15:30 IST!
    const sampleIst1520 = Date.UTC(2026, 6, 15, 9, 50, 0);
    const stub = cal.bucketBarTimestamp(sampleIst1520, '60', 'NSE');
    const stubOpen = getLocalParts(stub.openTime, 'Asia/Kolkata');
    const stubClose = getLocalParts(stub.closeTime, 'Asia/Kolkata');
    expect(`${stubOpen.hour}:${String(stubOpen.minute).padStart(2, '0')}`).toBe('15:15');
    expect(`${stubClose.hour}:${String(stubClose.minute).padStart(2, '0')}`).toBe('15:30');

    // Diwali Muhurat 2026 special session override (2026-11-08 18:00-19:00 IST)
    const muhurat = cal.getSessionWindow(Date.UTC(2026, 10, 8, 13, 0, 0), 'NSE');
    const mOpen = getLocalParts(muhurat.openUtcMs, 'Asia/Kolkata');
    const mClose = getLocalParts(muhurat.closeUtcMs, 'Asia/Kolkata');
    expect(`${mOpen.hour}:${String(mOpen.minute).padStart(2, '0')}`).toBe('18:00');
    expect(`${mClose.hour}:${String(mClose.minute).padStart(2, '0')}`).toBe('19:00');
  });

  it('anchors Forex NY-Close daily rollover across US EDT (21:00 UTC) and EST (22:00 UTC) and couples MCX close', () => {
    const cal = new SessionCalendar();

    // Summer (EDT, July 15 2026): 17:00 NY = 21:00 UTC; MCX closes 23:30 IST
    const summerMs = Date.UTC(2026, 6, 15, 14, 0, 0);
    const fxSummer = cal.getSessionWindow(summerMs, 'FOREX_OTC');
    expect(new Date(fxSummer.openUtcMs).getUTCHours()).toBe(21);
    const mcxSummer = cal.getSessionWindow(summerMs, 'MCX');
    const mcxSummerClose = getLocalParts(mcxSummer.closeUtcMs, 'Asia/Kolkata');
    expect(`${mcxSummerClose.hour}:${mcxSummerClose.minute}`).toBe('23:30');

    // Winter (EST, Jan 15 2026): 17:00 NY = 22:00 UTC; MCX closes 23:55 IST
    const winterMs = Date.UTC(2026, 0, 15, 14, 0, 0);
    const fxWinter = cal.getSessionWindow(winterMs, 'FOREX_OTC');
    expect(new Date(fxWinter.openUtcMs).getUTCHours()).toBe(22);
    const mcxWinter = cal.getSessionWindow(winterMs, 'MCX');
    const mcxWinterClose = getLocalParts(mcxWinter.closeUtcMs, 'Asia/Kolkata');
    expect(`${mcxWinterClose.hour}:${mcxWinterClose.minute}`).toBe('23:55');
  });

  it('maintains centered candle wick parity across 100%, 125%, 150%, and 200% DPI scaling', () => {
    for (const dpr of [1, 1.25, 1.5, 2]) {
      for (const spacing of [4, 7, 11, 18]) {
        const g = computeCandleBitmapMetrics(250.3, spacing, dpr);
        if (g.bodyWidthPx > 1) {
          expect(g.bodyWidthPx & 1).toBe(g.wickWidthPx & 1);
        }
        // Wick center sits strictly at the midpoint of the body
        expect(g.wickCenterPx).toBe(g.bodyLeftPx + g.bodyWidthPx / 2);
      }
    }
  });

  it('solves multi-pane tile layouts with scissor-clipped rects inside a 2-canvas tile', () => {
    const solver = new PaneLayoutSolver();
    const layout = solver.solve(1200, 700, [
      { id: 'main', weight: 0.72, minHeightPx: 120 },
      { id: 'rsi', weight: 0.28, minHeightPx: 80 },
    ]);
    expect(layout.panes).toHaveLength(2);
    expect(layout.dividers).toHaveLength(1);
    expect(layout.panes[0]!.rect.height + layout.panes[1]!.rect.height).toBe(layout.plotHeight);
    expect(layout.plotWidth + layout.rightAxisWidth).toBe(1200);
    expect(layout.plotHeight + layout.timeAxisHeight).toBe(700);
  });
});
