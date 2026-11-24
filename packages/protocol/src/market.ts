export type MarketCategory =
  | 'crypto'
  | 'forex'
  | 'commodities'
  | 'us_equity'
  | 'india_nse'
  | 'india_mcx'
  | 'futures'
  | 'index';

export type ExchangeCalendarId =
  | 'CRYPTO'
  | 'FOREX_OTC'
  | 'US_EQUITY'
  | 'NSE'
  | 'MCX';

export type FeedQualityBadge =
  | 'live_full_vol'
  | 'live_subset_vol'
  | 'live_quote_zero_vol'
  | 'delayed_eod'
  | 'replay';

export type Resolution =
  | '1S'
  | '5S'
  | '15S'
  | '30S'
  | '1'
  | '3'
  | '5'
  | '15'
  | '30'
  | '45'
  | '60'
  | '120'
  | '240'
  | '1D'
  | '1W'
  | '1M';

export type ChartStyle =
  | 'candles'
  | 'hollow_candles'
  | 'bars'
  | 'line'
  | 'step_line'
  | 'area'
  | 'baseline'
  | 'heikin_ashi';

export type PriceScaleMode =
  | 'linear'
  | 'symlog'
  | 'percentage'
  | 'indexed_to_100';

export interface OHLCVBar {
  /** Epoch milliseconds (UTC). Not required to be unique for non-time charts (Renko/Range). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SymbolInfo {
  /** Canonical symbol ID e.g. "BINANCE:BTCUSDT", "TIINGO:XAUUSD", "NSE:RELIANCE" */
  id: string;
  ticker: string;
  description: string;
  exchange: string;
  provider: string;
  market: MarketCategory;
  segment: 'spot' | 'perps' | 'futures' | 'options' | 'equity' | 'index' | 'fx';
  currency: string;
  timezone: string;
  calendarId: ExchangeCalendarId;
  /** Dynamic per-instrument minimum price movement (never hardcoded 0.05 for NSE) */
  tickSize: number;
  /** Display precision derived from tickSize (e.g. 2 for 0.01, 5 for 0.00001) */
  precision: number;
  lotSize: number;
  hasVolume: boolean;
  supportsOrderbook: boolean;
  supportsTicks: boolean;
  feedQuality: FeedQualityBadge;
  /** Optional futures volume proxy for zero-volume spot indices (e.g. NSE:NIFTY -> NSE:NIFTY1!) */
  futuresVolumeProxySymbol?: string;
  /** Fixed symlog linear threshold for zero-crossing spreads/oscillators */
  symlogLinthresh?: number;
}

export interface QuoteTick {
  symbol: string;
  last: number;
  change: number;
  changePct: number;
  bid?: number;
  ask?: number;
  volume?: number;
  timestamp: number;
  feedQuality: FeedQualityBadge;
}

export interface TradeTick {
  symbol: string;
  price: number;
  size: number;
  side: 'buy' | 'sell' | 'unknown';
  timestamp: number;
}

export interface OrderbookLevel {
  price: number;
  size: number;
}

export interface OrderbookDelta {
  symbol: string;
  sequence: number;
  isSnapshot: boolean;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  timestamp: number;
}

/**
 * Dynamic NSE 2025-2026 price-band tick size table (used as fallback when Broker Master lacks tickSize).
 */
export function computeNseDynamicTickSize(
  price: number,
  segment: 'equity' | 'index_futures' | 'etf' = 'equity',
): number {
  const p = Math.abs(price);
  if (segment === 'etf') {
    return 0.01;
  }
  if (segment === 'index_futures') {
    if (p < 15_000) return 0.05;
    if (p < 30_000) return 0.10;
    return 0.20;
  }
  if (p < 250) return 0.01;
  if (p <= 1_000) return 0.05;
  if (p <= 5_000) return 0.10;
  if (p <= 10_000) return 0.50;
  if (p <= 20_000) return 1.00;
  return 5.00;
}

export function precisionFromTickSize(tickSize: number): number {
  if (!Number.isFinite(tickSize) || tickSize <= 0) return 2;
  const s = tickSize.toFixed(10).replace(/0+$/, '');
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}
