import { SessionCalendar } from '@openview/chart-engine/model';
import type { ExchangeCalendarId, OHLCVBar, Resolution } from '@openview/protocol';

const sharedCalendar = new SessionCalendar();

/**
 * Deterministic exchange-session-anchored bar rollup (e.g. 1m -> 5m / 15m / 60m / 240m / 1D).
 * - Preserves Tiingo's 50 req/hr quota by rolling cached 1m bars locally into every higher TF.
 * - Normalizes Indian NSE REST 1H candles onto exact 09:15, 10:15, ..., 15:15-15:30 IST seams.
 * - Anchors FX 1D / 4H bars to 17:00 America/New_York across EDT/EST DST transitions.
 */
export function rollupBars(
  sourceBars: readonly OHLCVBar[],
  targetResolution: Resolution,
  calendarId: ExchangeCalendarId,
  extendedHours = false,
): OHLCVBar[] {
  if (sourceBars.length === 0) return [];
  const out: OHLCVBar[] = [];
  let current: OHLCVBar | null = null;
  let currentOpenTime = -1;

  for (const bar of sourceBars) {
    const { openTime } = sharedCalendar.bucketBarTimestamp(
      bar.time,
      targetResolution,
      calendarId,
      extendedHours,
    );

    if (current && openTime === currentOpenTime) {
      if (bar.high > current.high) current.high = bar.high;
      if (bar.low < current.low) current.low = bar.low;
      current.close = bar.close;
      current.volume += bar.volume;
    } else {
      current = {
        time: openTime,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
      };
      currentOpenTime = openTime;
      out.push(current);
    }
  }

  return out;
}

/**
 * Tail-Overlap Corporate Action Reconciliation Check (Section 2.3):
 * Compares overlapping historical closes between cached bars and freshly fetched bars.
 * If any overlapping bar diverges beyond 2 * tickSize (e.g. overnight 10:1 stock split or
 * 1:1 bonus issue), returns true so the stale symbol cache is automatically invalidated & backfilled.
 */
export function detectCorporateActionDivergence(
  cachedBars: readonly OHLCVBar[],
  freshBars: readonly OHLCVBar[],
  tickSize: number,
  overlapWindow = 5,
): { diverged: boolean; maxDiff: number; divergedTime?: number } {
  if (cachedBars.length === 0 || freshBars.length === 0) {
    return { diverged: false, maxDiff: 0 };
  }

  const cachedTail = cachedBars.slice(-Math.max(overlapWindow * 2, 10));
  const cachedByTime = new Map<number, OHLCVBar>();
  for (const b of cachedTail) cachedByTime.set(b.time, b);

  // Exclude the very latest forming bar when checking corporate action splits
  const settledFresh = freshBars.length > 1 ? freshBars.slice(0, -1) : freshBars;
  const threshold = Math.max(tickSize * 2, 1e-6);

  let checked = 0;
  let maxDiff = 0;
  for (let i = settledFresh.length - 1; i >= 0 && checked < overlapWindow; i--) {
    const fb = settledFresh[i]!;
    const cb = cachedByTime.get(fb.time);
    if (!cb) continue;
    checked++;
    const diff = Math.abs(cb.close - fb.close);
    if (diff > maxDiff) maxDiff = diff;
    if (diff > threshold) {
      return { diverged: true, maxDiff: diff, divergedTime: fb.time };
    }
  }

  return { diverged: false, maxDiff };
}
