import type { OHLCVBar } from '@openview/protocol';

export type MagnetMode = 'off' | 'weak' | 'strong';

export interface MagnetSnapResult {
  price: number;
  snapped: boolean;
  ohclField?: 'open' | 'high' | 'low' | 'close';
}

const WEAK_MAGNET_RADIUS_PX = 20;

/**
 * Weak & Strong OHLC Magnet Snapping:
 * - 'weak': snaps to nearest O/H/L/C of hovered bar when cursor is within 20 CSS px
 * - 'strong': always snaps vertically to the closest O/H/L/C price of the hovered bar
 */
export function applyOhlcMagnet(
  mode: MagnetMode,
  cursorY: number,
  rawPrice: number,
  bar: OHLCVBar | null,
  priceToY: (price: number) => number,
): MagnetSnapResult {
  if (mode === 'off' || !bar) {
    return { price: rawPrice, snapped: false };
  }

  const candidates: Array<{ field: 'open' | 'high' | 'low' | 'close'; price: number; dist: number }> = [
    { field: 'high', price: bar.high, dist: Math.abs(priceToY(bar.high) - cursorY) },
    { field: 'low', price: bar.low, dist: Math.abs(priceToY(bar.low) - cursorY) },
    { field: 'open', price: bar.open, dist: Math.abs(priceToY(bar.open) - cursorY) },
    { field: 'close', price: bar.close, dist: Math.abs(priceToY(bar.close) - cursorY) },
  ];

  candidates.sort((a, b) => a.dist - b.dist);
  const best = candidates[0]!;

  if (mode === 'strong' || best.dist <= WEAK_MAGNET_RADIUS_PX) {
    return { price: best.price, snapped: true, ohclField: best.field };
  }

  return { price: rawPrice, snapped: false };
}
