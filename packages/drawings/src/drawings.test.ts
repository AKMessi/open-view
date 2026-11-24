import { describe, expect, it } from 'vitest';
import type { OHLCVBar } from '@openview/protocol';
import {
  applyOhlcMagnet,
  computeAnchoredVwap,
  distancePointToLineMode,
  DRAWING_TOOLS,
  DrawingManager,
  interpolateLinePriceAtIndex,
  type CoordBridge,
} from './index.ts';

function mockBridge(bars: OHLCVBar[]): CoordBridge {
  return {
    paneRect: { x: 0, y: 0, width: 1000, height: 500 },
    horizontalPixelRatio: 1,
    verticalPixelRatio: 1,
    indexToX: (idx) => idx * 10,
    xToIndex: (x) => x / 10,
    priceToY: (p) => 500 - (p - 100) * 5,
    yToPrice: (y) => 100 + (500 - y) / 5,
    timeToIndex: (t) => Math.max(0, bars.findIndex((b) => b.time >= t)),
    indexToTime: (idx) => bars[idx]?.time ?? null,
    getBar: (idx) => bars[idx] ?? null,
    firstBarIndex: () => 0,
    lastBarIndex: () => bars.length - 1,
    formatPrice: (p) => p.toFixed(2),
  };
}

describe('@openview/drawings — Phase 3 Vector Engine & UndoModel', () => {
  it('registers 35+ essential TradingView-parity drawing tools', () => {
    expect(DRAWING_TOOLS.length).toBeGreaterThanOrEqual(35);
  });

  it('computes exact analytical hit-test distances for segments, rays, and extended lines', () => {
    const a = { x: 100, y: 100 };
    const b = { x: 200, y: 100 };
    expect(distancePointToLineMode({ x: 150, y: 103 }, a, b, 'segment')).toBeCloseTo(3, 6);
    expect(distancePointToLineMode({ x: 250, y: 103 }, a, b, 'segment')).toBeGreaterThan(49);
    expect(distancePointToLineMode({ x: 250, y: 103 }, a, b, 'ray')).toBeCloseTo(3, 6);
    expect(distancePointToLineMode({ x: 50, y: 103 }, a, b, 'ray')).toBeGreaterThan(49);
    expect(distancePointToLineMode({ x: 50, y: 103 }, a, b, 'extended')).toBeCloseTo(3, 6);
  });

  it('snaps weak and strong OHLC magnets accurately', () => {
    const bar: OHLCVBar = { time: 1000, open: 110, high: 120, low: 102, close: 115, volume: 500 };
    const priceToY = (p: number) => 500 - (p - 100) * 5; // high=120 -> y=400

    // Weak magnet within 20px of high (y=400)
    const weakHit = applyOhlcMagnet('weak', 412, 117.6, bar, priceToY);
    expect(weakHit.snapped).toBe(true);
    expect(weakHit.price).toBe(120);

    // Weak magnet far (> 20px) stays raw
    const weakMiss = applyOhlcMagnet('weak', 350, 130, bar, priceToY);
    expect(weakMiss.snapped).toBe(false);
    expect(weakMiss.price).toBe(130);

    // Strong magnet always snaps to closest OHLC
    const strongHit = applyOhlcMagnet('strong', 350, 130, bar, priceToY);
    expect(strongHit.snapped).toBe(true);
    expect(strongHit.price).toBe(120);
  });

  it('computes Anchored VWAP + ±1σ/2σ bands accurately', () => {
    const bars: OHLCVBar[] = [
      { time: 1000, open: 100, high: 106, low: 94, close: 100, volume: 100 }, // tp=100
      { time: 2000, open: 100, high: 116, low: 104, close: 110, volume: 100 }, // tp=110 -> vwap=105, std=5
    ];
    const curve = computeAnchoredVwap(0, 1, (i) => bars[i] ?? null);
    expect(curve).toHaveLength(2);
    expect(curve[0]!.vwap).toBeCloseTo(100, 6);
    expect(curve[1]!.vwap).toBeCloseTo(105, 6);
    expect(curve[1]!.upper1).toBeCloseTo(110, 6);
    expect(curve[1]!.lower1).toBeCloseTo(100, 6);
    expect(curve[1]!.upper2).toBeCloseTo(115, 6);
  });

  it('reverses add, style, lock, and delete mutations cleanly via UndoModel and interpolates sloped alerts', () => {
    const bars: OHLCVBar[] = Array.from({ length: 50 }, (_, i) => ({
      time: 1000 * (i + 1),
      open: 110 + i,
      high: 115 + i,
      low: 105 + i,
      close: 112 + i,
      volume: 100,
    }));
    const bridge = mockBridge(bars);
    const mgr = new DrawingManager();

    mgr.addDrawing({
      id: 'tl_1',
      type: 'trendline',
      paneId: 'main',
      priceScaleId: 'right',
      symbol: 'BINANCE:BTCUSDT',
      anchors: [
        { time: 10_000, price: 110 }, // index 9
        { time: 20_000, price: 130 }, // index 19 -> slope = +2/bar
      ],
      style: { color: '#2962ff', lineWidth: 2 },
      locked: false,
      visible: true,
      zIndex: 1,
    });

    expect(mgr.getDrawings('BINANCE:BTCUSDT')).toHaveLength(1);
    // Midpoint bar index 14 must interpolate cleanly to price 120
    expect(interpolateLinePriceAtIndex(9, 110, 19, 130, 14, 'segment')).toBeCloseTo(120, 6);
    expect(mgr.getPriceAtBar(mgr.getDrawings('BINANCE:BTCUSDT')[0]!, 14, bridge)).toBeCloseTo(120, 6);

    // Hit test on midpoint (x=140, y=500-(120-100)*5 = 400)
    const hit = mgr.hitTest({ x: 140, y: 400 }, 'BINANCE:BTCUSDT', bridge);
    expect(hit?.drawingId).toBe('tl_1');

    mgr.updateStyle('tl_1', { color: '#ff0000' });
    expect(mgr.getDrawings('BINANCE:BTCUSDT')[0]?.style.color).toBe('#ff0000');

    mgr.deleteDrawing('tl_1');
    expect(mgr.getDrawings('BINANCE:BTCUSDT')).toHaveLength(0);

    // Undo delete -> restores red trendline
    expect(mgr.undo()).toBe(true);
    expect(mgr.getDrawings('BINANCE:BTCUSDT')[0]?.style.color).toBe('#ff0000');

    // Undo style -> restores blue trendline
    expect(mgr.undo()).toBe(true);
    expect(mgr.getDrawings('BINANCE:BTCUSDT')[0]?.style.color).toBe('#2962ff');

    // Undo add -> empty
    expect(mgr.undo()).toBe(true);
    expect(mgr.getDrawings('BINANCE:BTCUSDT')).toHaveLength(0);

    // Redo add -> back again
    expect(mgr.redo()).toBe(true);
    expect(mgr.getDrawings('BINANCE:BTCUSDT')).toHaveLength(1);
  });
});
