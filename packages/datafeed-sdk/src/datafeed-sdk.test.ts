import { describe, expect, it } from 'vitest';
import { getLocalParts } from '@openview/chart-engine';
import type { OHLCVBar } from '@openview/protocol';
import {
  detectCorporateActionDivergence,
  parseCsvBars,
  rollupBars,
  searchCatalog,
  stitchContinuousFutures,
} from './index.ts';

describe('@openview/datafeed-sdk', () => {
  it('stitches continuous futures contracts (NIFTY1!) with Panama difference and ratio adjustments', () => {
    const april: OHLCVBar[] = [
      { time: 1000, open: 24000, high: 24100, low: 23950, close: 24050, volume: 100 },
      { time: 2000, open: 24050, high: 24120, low: 24000, close: 24100, volume: 120 },
    ];
    const may: OHLCVBar[] = [
      // +150 point roll premium on expiry switch
      { time: 3000, open: 24250, high: 24300, low: 24200, close: 24280, volume: 150 },
    ];

    const diffStitched = stitchContinuousFutures(
      [
        { contractCode: 'NIFTY26APR', activeFromMs: 0, bars: april },
        { contractCode: 'NIFTY26MAY', activeFromMs: 3000, bars: may },
      ],
      'difference',
    );
    expect(diffStitched).toHaveLength(3);
    // Most recent contract stays unadjusted; older contract shifts by +150
    expect(diffStitched[2]!.open).toBe(24250);
    expect(diffStitched[1]!.close).toBe(24250);
    expect(diffStitched[0]!.open).toBe(24150);

    const ratioStitched = stitchContinuousFutures(
      [
        { contractCode: 'NIFTY26APR', activeFromMs: 0, bars: april },
        { contractCode: 'NIFTY26MAY', activeFromMs: 3000, bars: may },
      ],
      'ratio',
    );
    expect(ratioStitched[1]!.close).toBeCloseTo(24250, 6);
    expect(ratioStitched[2]!.close).toBe(24280);
  });

  it('rolls 1m NSE bars cleanly onto 09:15 IST 1H session-anchored seams (never 09:00/10:00)', () => {
    // 09:15 IST = 03:45 UTC, 10:14 IST = 04:44 UTC, 10:15 IST = 04:45 UTC
    const bars1m: OHLCVBar[] = [
      { time: Date.UTC(2026, 6, 15, 3, 45, 0), open: 100, high: 105, low: 99, close: 104, volume: 10 },
      { time: Date.UTC(2026, 6, 15, 4, 44, 0), open: 104, high: 108, low: 103, close: 107, volume: 20 },
      { time: Date.UTC(2026, 6, 15, 4, 45, 0), open: 107, high: 112, low: 106, close: 110, volume: 30 },
    ];
    const bars1h = rollupBars(bars1m, '60', 'NSE');
    expect(bars1h).toHaveLength(2);
    const p0 = getLocalParts(bars1h[0]!.time, 'Asia/Kolkata');
    const p1 = getLocalParts(bars1h[1]!.time, 'Asia/Kolkata');
    expect(`${p0.hour}:${String(p0.minute).padStart(2, '0')}`).toBe('9:15');
    expect(`${p1.hour}:${String(p1.minute).padStart(2, '0')}`).toBe('10:15');
    expect(bars1h[0]!.high).toBe(108);
    expect(bars1h[0]!.volume).toBe(30);
    expect(bars1h[1]!.open).toBe(107);
  });

  it('detects overnight stock split / bonus corporate action divergence on cached tail overlap', () => {
    const cached: OHLCVBar[] = [
      { time: 1000, open: 1200, high: 1220, low: 1190, close: 1200, volume: 1000 },
      { time: 2000, open: 1200, high: 1250, low: 1195, close: 1240, volume: 1100 },
    ];
    // Post 10:1 NVDA-style split: fresh adjusted history has close = 124.0 instead of 1240
    const postSplit: OHLCVBar[] = [
      { time: 1000, open: 120, high: 122, low: 119, close: 120, volume: 10000 },
      { time: 2000, open: 120, high: 125, low: 119.5, close: 124, volume: 11000 },
      { time: 3000, open: 125, high: 128, low: 124, close: 127, volume: 9000 },
    ];
    const check = detectCorporateActionDivergence(cached, postSplit, 0.01);
    expect(check.diverged).toBe(true);
    expect(check.maxDiff).toBeGreaterThan(1000);
  });

  it('parses CSV OHLCV files with mixed Unix/ISO timestamps cleanly', () => {
    const csv = [
      'Date,Open,High,Low,Close,Volume',
      '2026-01-02,100.5,103.0,99.5,102.0,5000',
      '2026-01-03,102.0,106.0,101.0,105.5,6200',
    ].join('\n');
    const bars = parseCsvBars(csv);
    expect(bars).toHaveLength(2);
    expect(bars[0]!.open).toBe(100.5);
    expect(bars[1]!.close).toBe(105.5);
    expect(bars[1]!.volume).toBe(6200);
  });

  it('searches across all 4 markets (Crypto, Forex/Gold, US, India NSE/MCX)', () => {
    expect(searchCatalog('XAU', 'forex')[0]?.id).toBe('FX:XAUUSD');
    expect(searchCatalog('RELIANCE', 'india_nse')[0]?.id).toBe('NSE:RELIANCE');
    expect(searchCatalog('NVDA', 'us_equity')[0]?.id).toBe('US:NVDA');
    expect(searchCatalog('BTC', 'crypto')[0]?.id).toBe('BINANCE:BTCUSDT');
  });
});
