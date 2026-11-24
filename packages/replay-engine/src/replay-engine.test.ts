import { describe, expect, it } from 'vitest';
import type { OHLCVBar } from '@openview/protocol';
import { MasterReplayClock } from './index.ts';

describe('@openview/replay-engine — Zero-Lookahead Multi-TF Invariant', () => {
  it('never leaks future intrabar spikes into forming higher-timeframe candles', () => {
    // Construct 60 consecutive 1m bars starting at 09:15 IST (03:45 UTC) on 2026-07-15
    const startUtc = Date.UTC(2026, 6, 15, 3, 45, 0);
    const bars1m: OHLCVBar[] = Array.from({ length: 60 }, (_, m) => ({
      time: startUtc + m * 60_000,
      open: 100,
      // Huge future spike ONLY at minute 45 (10:00 IST)!
      high: m === 45 ? 999 : 102,
      low: 98,
      close: m === 45 ? 500 : 101,
      volume: 10,
    }));

    const clock = new MasterReplayClock();
    // Start replay at minute 5 (09:20 IST)
    clock.start(bars1m, 5);

    const htfAt0920 = clock.getRolledUpSeries('60', 'NSE');
    expect(htfAt0920).toHaveLength(1);
    // Zero lookahead: the 09:15 1H candle MUST NOT see the minute-45 spike (999)!
    expect(htfAt0920[0]!.high).toBe(102);
    expect(htfAt0920[0]!.close).toBe(101);
    expect(htfAt0920[0]!.volume).toBe(60); // 6 bars * 10

    // Advance cursor past minute 45
    clock.jumpToIndex(46);
    const htfAt1001 = clock.getRolledUpSeries('60', 'NSE');
    expect(htfAt1001).toHaveLength(1);
    expect(htfAt1001[0]!.high).toBe(999);
    expect(htfAt1001[0]!.volume).toBe(470);
  });
});
