import {
  computeNseDynamicTickSize,
  precisionFromTickSize,
  type OHLCVBar,
  type Resolution,
  type SymbolInfo,
} from '@openview/protocol';
import { resolutionToMs } from '../model/session-calendar.ts';

export const DEMO_SYMBOLS: Record<string, SymbolInfo> = {
  'BINANCE:BTCUSDT': {
    id: 'BINANCE:BTCUSDT',
    ticker: 'BTCUSDT',
    description: 'Bitcoin / Tether USD',
    exchange: 'BINANCE',
    provider: 'binance',
    market: 'crypto',
    segment: 'spot',
    currency: 'USDT',
    timezone: 'UTC',
    calendarId: 'CRYPTO',
    tickSize: 0.01,
    precision: 2,
    lotSize: 0.00001,
    hasVolume: true,
    supportsOrderbook: true,
    supportsTicks: true,
    feedQuality: 'live_full_vol',
  },
  'TIINGO:XAUUSD': {
    id: 'TIINGO:XAUUSD',
    ticker: 'XAUUSD',
    description: 'Spot Gold / US Dollar',
    exchange: 'OTC FX',
    provider: 'tiingo',
    market: 'commodities',
    segment: 'fx',
    currency: 'USD',
    timezone: 'America/New_York',
    calendarId: 'FOREX_OTC',
    tickSize: 0.01,
    precision: 2,
    lotSize: 1,
    hasVolume: true,
    supportsOrderbook: false,
    supportsTicks: true,
    feedQuality: 'live_quote_zero_vol',
  },
  'TIINGO:EURUSD': {
    id: 'TIINGO:EURUSD',
    ticker: 'EURUSD',
    description: 'Euro / US Dollar',
    exchange: 'OTC FX',
    provider: 'tiingo',
    market: 'forex',
    segment: 'fx',
    currency: 'USD',
    timezone: 'America/New_York',
    calendarId: 'FOREX_OTC',
    tickSize: 0.00001,
    precision: 5,
    lotSize: 1000,
    hasVolume: true,
    supportsOrderbook: false,
    supportsTicks: true,
    feedQuality: 'live_quote_zero_vol',
  },
  'ALPACA:NVDA': {
    id: 'ALPACA:NVDA',
    ticker: 'NVDA',
    description: 'NVIDIA Corporation',
    exchange: 'NASDAQ',
    provider: 'alpaca',
    market: 'us_equity',
    segment: 'equity',
    currency: 'USD',
    timezone: 'America/New_York',
    calendarId: 'US_EQUITY',
    tickSize: 0.01,
    precision: 2,
    lotSize: 1,
    hasVolume: true,
    supportsOrderbook: false,
    supportsTicks: true,
    feedQuality: 'live_subset_vol',
  },
  'NSE:RELIANCE': {
    id: 'NSE:RELIANCE',
    ticker: 'RELIANCE',
    description: 'Reliance Industries Ltd',
    exchange: 'NSE',
    provider: 'upstox',
    market: 'india_nse',
    segment: 'equity',
    currency: 'INR',
    timezone: 'Asia/Kolkata',
    calendarId: 'NSE',
    tickSize: computeNseDynamicTickSize(1340, 'equity'),
    precision: precisionFromTickSize(computeNseDynamicTickSize(1340, 'equity')),
    lotSize: 1,
    hasVolume: true,
    supportsOrderbook: true,
    supportsTicks: true,
    feedQuality: 'live_full_vol',
  },
  'NSE:NIFTY': {
    id: 'NSE:NIFTY',
    ticker: 'NIFTY 50',
    description: 'NSE NIFTY 50 Spot Index (Zero Volume)',
    exchange: 'NSE',
    provider: 'upstox',
    market: 'india_nse',
    segment: 'index',
    currency: 'INR',
    timezone: 'Asia/Kolkata',
    calendarId: 'NSE',
    tickSize: 0.05,
    precision: 2,
    lotSize: 75,
    hasVolume: false,
    supportsOrderbook: false,
    supportsTicks: true,
    feedQuality: 'live_quote_zero_vol',
    futuresVolumeProxySymbol: 'NSE:NIFTY1!',
  },
};

/**
 * Deterministic seeded PRNG (Mulberry32) for reproducible tests and 250k-bar stress benchmarks.
 */
export function generateSyntheticBars(
  symbol: SymbolInfo,
  resolution: Resolution,
  count: number,
  seed = 42,
): OHLCVBar[] {
  let state = seed >>> 0;
  const rand = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const basePrices: Record<string, number> = {
    'BINANCE:BTCUSDT': 92_400,
    'TIINGO:XAUUSD': 2_685,
    'TIINGO:EURUSD': 1.0845,
    'ALPACA:NVDA': 142.5,
    'NSE:RELIANCE': 1_340.5,
    'NSE:NIFTY': 24_350.0,
  };

  let price = basePrices[symbol.id] ?? 100;
  const volScale = symbol.market === 'forex' ? 0.0006 : symbol.market === 'crypto' ? 0.0045 : 0.0025;
  const stepMs = resolutionToMs(resolution);
  const endTime = Math.floor(Date.now() / stepMs) * stepMs;
  const startTime = endTime - count * stepMs;
  const bars = new Array<OHLCVBar>(count);

  for (let i = 0; i < count; i++) {
    const drift = (rand() - 0.496) * 2 * volScale * price;
    const open = price;
    const close = Math.max(symbol.tickSize * 10, open + drift);
    const wickUp = Math.abs(rand() * volScale * price * 1.1);
    const wickDown = Math.abs(rand() * volScale * price * 1.1);
    const high = Math.max(open, close) + wickUp;
    const low = Math.max(symbol.tickSize, Math.min(open, close) - wickDown);
    const volume = symbol.hasVolume ? Math.round((0.3 + rand() * 3.5) * 12_000) : 0;

    bars[i] = {
      time: startTime + i * stepMs,
      open,
      high,
      low,
      close,
      volume,
    };
    price = close;
  }

  return bars;
}
