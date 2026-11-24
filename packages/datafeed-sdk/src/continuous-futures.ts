import type { OHLCVBar } from '@openview/protocol';

export type BackAdjustmentMode = 'none' | 'difference' | 'ratio';

export interface ContractSegment {
  contractCode: string; // e.g. "NIFTY26APR", "NIFTY26MAY"
  /** Timestamp from which this contract becomes the active front month */
  activeFromMs: number;
  bars: readonly OHLCVBar[];
}

/**
 * Stitches sequential futures expiry contracts into a continuous contract series (e.g. NIFTY1!, MCX:GOLD1!)
 * using TradingView-parity back-adjustment:
 * - 'none': raw unadjusted front-month splice
 * - 'difference' (Panama additive): shifts all historical segments by the rollover close gap
 * - 'ratio' (multiplicative): scales historical segments by newClose / oldClose to preserve % returns
 */
export function stitchContinuousFutures(
  segments: readonly ContractSegment[],
  mode: BackAdjustmentMode = 'difference',
): OHLCVBar[] {
  if (segments.length === 0) return [];
  const ordered = [...segments].sort((a, b) => a.activeFromMs - b.activeFromMs);

  // Slice each segment to its active window [activeFromMs, nextSegment.activeFromMs)
  const slices: OHLCVBar[][] = [];
  for (let i = 0; i < ordered.length; i++) {
    const seg = ordered[i]!;
    const nextStart = ordered[i + 1]?.activeFromMs ?? Infinity;
    const activeBars = seg.bars
      .filter((b) => b.time >= seg.activeFromMs && b.time < nextStart)
      .map((b) => ({ ...b }));
    if (activeBars.length > 0) {
      slices.push(activeBars);
    }
  }

  if (slices.length <= 1 || mode === 'none') {
    return slices.flat().sort((a, b) => a.time - b.time);
  }

  // Walk backwards from most recent active contract so current prices stay 100% unadjusted!
  let cumulativeDiff = 0;
  let cumulativeRatio = 1;

  for (let i = slices.length - 2; i >= 0; i--) {
    const olderSlice = slices[i]!;
    const newerSlice = slices[i + 1]!;
    const olderLast = olderSlice[olderSlice.length - 1]!;
    const newerFirst = newerSlice[0]!;

    // Compute exact roll adjustment at splice boundary
    if (mode === 'difference') {
      const gap = newerFirst.open - olderLast.close;
      cumulativeDiff += gap;
      for (const b of olderSlice) {
        b.open += cumulativeDiff;
        b.high += cumulativeDiff;
        b.low += cumulativeDiff;
        b.close += cumulativeDiff;
      }
    } else if (mode === 'ratio' && olderLast.close > 0 && newerFirst.open > 0) {
      const factor = newerFirst.open / olderLast.close;
      cumulativeRatio *= factor;
      for (const b of olderSlice) {
        b.open *= cumulativeRatio;
        b.high *= cumulativeRatio;
        b.low *= cumulativeRatio;
        b.close *= cumulativeRatio;
      }
    }
  }

  return slices.flat().sort((a, b) => a.time - b.time);
}
