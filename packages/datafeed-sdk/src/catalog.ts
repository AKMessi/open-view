import {
  computeNseDynamicTickSize,
  precisionFromTickSize,
  type MarketCategory,
  type SymbolInfo,
} from '@openview/protocol';

function nseEquity(ticker: string, description: string, refPrice: number): SymbolInfo {
  const tickSize = computeNseDynamicTickSize(refPrice, 'equity');
  return {
    id: `NSE:${ticker}`,
    ticker,
    description,
    exchange: 'NSE',
    provider: 'nse_auto',
    market: 'india_nse',
    segment: 'equity',
    currency: 'INR',
    timezone: 'Asia/Kolkata',
    calendarId: 'NSE',
    tickSize,
    precision: precisionFromTickSize(tickSize),
    lotSize: 1,
    hasVolume: true,
    supportsOrderbook: true,
    supportsTicks: true,
    feedQuality: 'delayed_eod',
  };
}

export const SYMBOL_CATALOG: readonly SymbolInfo[] = [
  // ── 1. CRYPTO (Zero-Key Live Public Streams) ────────────────────────────
  {
    id: 'BINANCE:BTCUSDT',
    ticker: 'BTCUSDT',
    description: 'Bitcoin / Tether USD (Spot)',
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
  {
    id: 'BINANCE:ETHUSDT',
    ticker: 'ETHUSDT',
    description: 'Ethereum / Tether USD (Spot)',
    exchange: 'BINANCE',
    provider: 'binance',
    market: 'crypto',
    segment: 'spot',
    currency: 'USDT',
    timezone: 'UTC',
    calendarId: 'CRYPTO',
    tickSize: 0.01,
    precision: 2,
    lotSize: 0.0001,
    hasVolume: true,
    supportsOrderbook: true,
    supportsTicks: true,
    feedQuality: 'live_full_vol',
  },
  {
    id: 'BINANCE:SOLUSDT',
    ticker: 'SOLUSDT',
    description: 'Solana / Tether USD (Spot)',
    exchange: 'BINANCE',
    provider: 'binance',
    market: 'crypto',
    segment: 'spot',
    currency: 'USDT',
    timezone: 'UTC',
    calendarId: 'CRYPTO',
    tickSize: 0.01,
    precision: 2,
    lotSize: 0.01,
    hasVolume: true,
    supportsOrderbook: true,
    supportsTicks: true,
    feedQuality: 'live_full_vol',
  },
  {
    id: 'BINANCE:PAXGUSDT',
    ticker: 'PAXGUSDT',
    description: 'PAX Gold / USDT (24/7 Tokenized Physical Gold Proxy)',
    exchange: 'BINANCE',
    provider: 'binance',
    market: 'commodities',
    segment: 'spot',
    currency: 'USDT',
    timezone: 'UTC',
    calendarId: 'CRYPTO',
    tickSize: 0.1,
    precision: 1,
    lotSize: 0.001,
    hasVolume: true,
    supportsOrderbook: true,
    supportsTicks: true,
    feedQuality: 'live_full_vol',
  },
  {
    id: 'BINANCE:BTCUSDT.P',
    ticker: 'BTCUSDT.P',
    description: 'Bitcoin USD-M Perpetual Futures',
    exchange: 'BINANCE PERP',
    provider: 'binance_perp',
    market: 'crypto',
    segment: 'perps',
    currency: 'USDT',
    timezone: 'UTC',
    calendarId: 'CRYPTO',
    tickSize: 0.1,
    precision: 1,
    lotSize: 0.001,
    hasVolume: true,
    supportsOrderbook: true,
    supportsTicks: true,
    feedQuality: 'live_full_vol',
  },

  // ── 2. FOREX, GOLD & ENERGY (OTC NY-Close 17:00 ET) ─────────────────────
  {
    id: 'FX:XAUUSD',
    ticker: 'XAUUSD',
    description: 'Spot Gold / US Dollar',
    exchange: 'FX OTC',
    provider: 'fx_auto',
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
  {
    id: 'FX:XAGUSD',
    ticker: 'XAGUSD',
    description: 'Spot Silver / US Dollar',
    exchange: 'FX OTC',
    provider: 'fx_auto',
    market: 'commodities',
    segment: 'fx',
    currency: 'USD',
    timezone: 'America/New_York',
    calendarId: 'FOREX_OTC',
    tickSize: 0.001,
    precision: 3,
    lotSize: 50,
    hasVolume: true,
    supportsOrderbook: false,
    supportsTicks: true,
    feedQuality: 'live_quote_zero_vol',
  },
  {
    id: 'FX:EURUSD',
    ticker: 'EURUSD',
    description: 'Euro / US Dollar',
    exchange: 'FX OTC',
    provider: 'fx_auto',
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
  {
    id: 'FX:GBPUSD',
    ticker: 'GBPUSD',
    description: 'British Pound / US Dollar',
    exchange: 'FX OTC',
    provider: 'fx_auto',
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
  {
    id: 'FX:USDJPY',
    ticker: 'USDJPY',
    description: 'US Dollar / Japanese Yen',
    exchange: 'FX OTC',
    provider: 'fx_auto',
    market: 'forex',
    segment: 'fx',
    currency: 'JPY',
    timezone: 'America/New_York',
    calendarId: 'FOREX_OTC',
    tickSize: 0.001,
    precision: 3,
    lotSize: 1000,
    hasVolume: true,
    supportsOrderbook: false,
    supportsTicks: true,
    feedQuality: 'live_quote_zero_vol',
  },
  {
    id: 'FX:USDINR',
    ticker: 'USDINR',
    description: 'US Dollar / Indian Rupee',
    exchange: 'FX OTC',
    provider: 'fx_auto',
    market: 'forex',
    segment: 'fx',
    currency: 'INR',
    timezone: 'Asia/Kolkata',
    calendarId: 'FOREX_OTC',
    tickSize: 0.0025,
    precision: 4,
    lotSize: 1000,
    hasVolume: true,
    supportsOrderbook: false,
    supportsTicks: true,
    feedQuality: 'live_quote_zero_vol',
  },
  ...([
    ['AUDUSD', 'Australian Dollar / US Dollar', 'USD', 0.00001, 5, 'forex'],
    ['USDCAD', 'US Dollar / Canadian Dollar', 'CAD', 0.00001, 5, 'forex'],
    ['USDCHF', 'US Dollar / Swiss Franc', 'CHF', 0.00001, 5, 'forex'],
    ['NZDUSD', 'New Zealand Dollar / US Dollar', 'USD', 0.00001, 5, 'forex'],
    ['EURJPY', 'Euro / Japanese Yen', 'JPY', 0.001, 3, 'forex'],
    ['GBPJPY', 'British Pound / Japanese Yen', 'JPY', 0.001, 3, 'forex'],
    ['EURGBP', 'Euro / British Pound', 'GBP', 0.00001, 5, 'forex'],
    ['USOIL', 'WTI Crude Oil Futures (CL=F)', 'USD', 0.01, 2, 'commodities'],
    ['UKOIL', 'Brent Crude Oil Futures (BZ=F)', 'USD', 0.01, 2, 'commodities'],
    ['NATGAS', 'Henry Hub Natural Gas (NG=F)', 'USD', 0.001, 3, 'commodities'],
    ['COPPER', 'High Grade Copper Futures (HG=F)', 'USD', 0.0005, 4, 'commodities'],
    ['DXY', 'US Dollar Currency Index', 'USD', 0.01, 2, 'index'],
  ] as const).map(
    ([ticker, description, currency, tickSize, precision, market]): SymbolInfo => ({
      id: `FX:${ticker}`,
      ticker,
      description,
      exchange: market === 'commodities' ? 'COMMODITY' : market === 'index' ? 'INDEX' : 'FX OTC',
      provider: 'fx_auto',
      market,
      segment: market === 'index' ? 'index' : 'fx',
      currency,
      timezone: 'America/New_York',
      calendarId: 'FOREX_OTC',
      tickSize,
      precision,
      lotSize: 1,
      hasVolume: market === 'commodities',
      supportsOrderbook: false,
      supportsTicks: true,
      feedQuality: 'live_quote_zero_vol',
    }),
  ),

  // ── 3. US EQUITIES, ETFs & INDICES ──────────────────────────────────────
  ...([
    ['AAPL', 'Apple Inc.', 'NASDAQ'],
    ['NVDA', 'NVIDIA Corporation', 'NASDAQ'],
    ['MSFT', 'Microsoft Corporation', 'NASDAQ'],
    ['TSLA', 'Tesla, Inc.', 'NASDAQ'],
    ['AMZN', 'Amazon.com, Inc.', 'NASDAQ'],
    ['META', 'Meta Platforms, Inc.', 'NASDAQ'],
    ['GOOGL', 'Alphabet Inc. Class A', 'NASDAQ'],
    ['AMD', 'Advanced Micro Devices, Inc.', 'NASDAQ'],
    ['PLTR', 'Palantir Technologies Inc.', 'NASDAQ'],
    ['NFLX', 'Netflix, Inc.', 'NASDAQ'],
    ['COIN', 'Coinbase Global, Inc.', 'NASDAQ'],
    ['SPY', 'SPDR S&P 500 ETF Trust', 'ARCA'],
    ['QQQ', 'Invesco QQQ Trust', 'NASDAQ'],
    ['SPX', 'S&P 500 Index', 'INDEX'],
    ['NDX', 'NASDAQ-100 Index', 'INDEX'],
    ['VIX', 'CBOE Volatility Index', 'CBOE'],
  ] as const).map(
    ([ticker, description, exchange]): SymbolInfo => ({
      id: `US:${ticker}`,
      ticker,
      description,
      exchange,
      provider: 'us_auto',
      market: exchange === 'INDEX' || exchange === 'CBOE' ? 'index' : 'us_equity',
      segment: exchange === 'INDEX' || exchange === 'CBOE' ? 'index' : 'equity',
      currency: 'USD',
      timezone: 'America/New_York',
      calendarId: 'US_EQUITY',
      tickSize: 0.01,
      precision: 2,
      lotSize: 1,
      hasVolume: exchange !== 'INDEX' && exchange !== 'CBOE',
      supportsOrderbook: false,
      supportsTicks: true,
      feedQuality: 'delayed_eod',
    }),
  ),

  // ── 4. INDIAN NSE, INDICES, CONTINUOUS FUTURES & MCX ────────────────────
  {
    id: 'NSE:NIFTY',
    ticker: 'NIFTY',
    description: 'NIFTY 50 Spot Index (Zero Volume · Proxy: NIFTY1!)',
    exchange: 'NSE',
    provider: 'nse_auto',
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
  {
    id: 'NSE:BANKNIFTY',
    ticker: 'BANKNIFTY',
    description: 'NIFTY Bank Spot Index (Zero Volume · Proxy: BANKNIFTY1!)',
    exchange: 'NSE',
    provider: 'nse_auto',
    market: 'india_nse',
    segment: 'index',
    currency: 'INR',
    timezone: 'Asia/Kolkata',
    calendarId: 'NSE',
    tickSize: 0.05,
    precision: 2,
    lotSize: 30,
    hasVolume: false,
    supportsOrderbook: false,
    supportsTicks: true,
    feedQuality: 'live_quote_zero_vol',
    futuresVolumeProxySymbol: 'NSE:BANKNIFTY1!',
  },
  {
    id: 'NSE:NIFTY1!',
    ticker: 'NIFTY1!',
    description: 'NIFTY 50 Continuous Front-Month Futures',
    exchange: 'NSE F&O',
    provider: 'nse_auto',
    market: 'futures',
    segment: 'futures',
    currency: 'INR',
    timezone: 'Asia/Kolkata',
    calendarId: 'NSE',
    tickSize: computeNseDynamicTickSize(24_500, 'index_futures'),
    precision: precisionFromTickSize(computeNseDynamicTickSize(24_500, 'index_futures')),
    lotSize: 75,
    hasVolume: true,
    supportsOrderbook: true,
    supportsTicks: true,
    feedQuality: 'delayed_eod',
  },
  {
    id: 'NSE:BANKNIFTY1!',
    ticker: 'BANKNIFTY1!',
    description: 'BANKNIFTY Continuous Front-Month Futures',
    exchange: 'NSE F&O',
    provider: 'nse_auto',
    market: 'futures',
    segment: 'futures',
    currency: 'INR',
    timezone: 'Asia/Kolkata',
    calendarId: 'NSE',
    tickSize: computeNseDynamicTickSize(52_000, 'index_futures'),
    precision: precisionFromTickSize(computeNseDynamicTickSize(52_000, 'index_futures')),
    lotSize: 30,
    hasVolume: true,
    supportsOrderbook: true,
    supportsTicks: true,
    feedQuality: 'delayed_eod',
  },
  nseEquity('RELIANCE', 'Reliance Industries Ltd', 1340),
  nseEquity('TCS', 'Tata Consultancy Services Ltd', 4120),
  nseEquity('HDFCBANK', 'HDFC Bank Ltd', 1760),
  nseEquity('ICICIBANK', 'ICICI Bank Ltd', 1290),
  nseEquity('INFY', 'Infosys Ltd', 1880),
  nseEquity('SBIN', 'State Bank of India', 840),
  nseEquity('TATAMOTORS', 'Tata Motors Ltd', 780),
  nseEquity('ITC', 'ITC Ltd', 470),
  {
    id: 'MCX:GOLD1!',
    ticker: 'GOLD1!',
    description: 'MCX Gold Continuous Front-Month Futures (US-DST Close)',
    exchange: 'MCX',
    provider: 'nse_auto',
    market: 'india_mcx',
    segment: 'futures',
    currency: 'INR',
    timezone: 'Asia/Kolkata',
    calendarId: 'MCX',
    tickSize: 1.0,
    precision: 0,
    lotSize: 1,
    hasVolume: true,
    supportsOrderbook: true,
    supportsTicks: true,
    feedQuality: 'delayed_eod',
  },
  {
    id: 'MCX:CRUDEOIL1!',
    ticker: 'CRUDEOIL1!',
    description: 'MCX Crude Oil Continuous Front-Month Futures (US-DST Close)',
    exchange: 'MCX',
    provider: 'nse_auto',
    market: 'india_mcx',
    segment: 'futures',
    currency: 'INR',
    timezone: 'Asia/Kolkata',
    calendarId: 'MCX',
    tickSize: 1.0,
    precision: 0,
    lotSize: 100,
    hasVolume: true,
    supportsOrderbook: true,
    supportsTicks: true,
    feedQuality: 'delayed_eod',
  },
];

export const DEFAULT_WATCHLIST_IDS: readonly string[] = [
  'BINANCE:BTCUSDT',
  'BINANCE:ETHUSDT',
  'BINANCE:SOLUSDT',
  'BINANCE:PAXGUSDT',
  'FX:XAUUSD',
  'FX:EURUSD',
  'US:NVDA',
  'US:AAPL',
  'US:SPY',
  'NSE:NIFTY',
  'NSE:BANKNIFTY',
  'NSE:NIFTY1!',
  'NSE:RELIANCE',
  'NSE:TCS',
  'NSE:HDFCBANK',
];

const catalogById = new Map<string, SymbolInfo>(SYMBOL_CATALOG.map((s) => [s.id.toUpperCase(), s]));
const dynamicSymbolRegistry = new Map<string, SymbolInfo>();

export function registerDynamicSymbol(sym: SymbolInfo): void {
  const key = sym.id.trim().toUpperCase();
  if (!catalogById.has(key)) {
    dynamicSymbolRegistry.set(key, sym);
  }
}

export function refineSymbolPrecision(sym: SymbolInfo, refPrice: number): SymbolInfo {
  if (!Number.isFinite(refPrice) || refPrice <= 0) return sym;
  // Preserve explicit curated precision for major instruments; refine sub-cent dynamic assets (e.g. PEPEUSDT)
  const abs = Math.abs(refPrice);
  if (abs < 0.0001 && sym.precision < 8) {
    return { ...sym, tickSize: 1e-8, precision: 8 };
  }
  if (abs < 0.01 && sym.precision < 6) {
    return { ...sym, tickSize: 1e-6, precision: 6 };
  }
  if (abs < 1 && sym.precision < 4) {
    return { ...sym, tickSize: 1e-4, precision: 4 };
  }
  return sym;
}

export function findSymbolById(symbolId: string): SymbolInfo | null {
  const key = symbolId.trim().toUpperCase();
  const exact = catalogById.get(key) ?? dynamicSymbolRegistry.get(key);
  if (exact) return exact;

  // Dynamic symbol fallback (e.g., user types BINANCE:DOGEUSDT or US:GOOGL or NSE:WIPRO)
  const colonIdx = key.indexOf(':');
  if (colonIdx > 0) {
    const prefix = key.slice(0, colonIdx);
    const ticker = key.slice(colonIdx + 1);
    if (prefix === 'BINANCE') {
      const isPerp = ticker.endsWith('.P');
      return {
        id: key,
        ticker,
        description: `${ticker} (Binance ${isPerp ? 'Perp' : 'Spot'})`,
        exchange: isPerp ? 'BINANCE PERP' : 'BINANCE',
        provider: isPerp ? 'binance_perp' : 'binance',
        market: 'crypto',
        segment: isPerp ? 'perps' : 'spot',
        currency: 'USDT',
        timezone: 'UTC',
        calendarId: 'CRYPTO',
        tickSize: 0.0001,
        precision: 4,
        lotSize: 1,
        hasVolume: true,
        supportsOrderbook: true,
        supportsTicks: true,
        feedQuality: 'live_full_vol',
      };
    }
    if (prefix === 'HYPERLIQUID') {
      const coin = ticker.replace(/-PERP$/i, '');
      return {
        id: key,
        ticker: `${coin}-PERP`,
        description: `${coin} Perpetual Futures (Hyperliquid)`,
        exchange: 'HYPERLIQUID',
        provider: 'hyperliquid',
        market: 'crypto',
        segment: 'perps',
        currency: 'USD',
        timezone: 'UTC',
        calendarId: 'CRYPTO',
        tickSize: 0.0001,
        precision: 4,
        lotSize: 0.01,
        hasVolume: true,
        supportsOrderbook: true,
        supportsTicks: true,
        feedQuality: 'live_full_vol',
      };
    }
    if (prefix === 'FX') {
      const isJpy = ticker.endsWith('JPY');
      const isInr = ticker.endsWith('INR');
      const isMetalOrOil = ['XAUUSD', 'XAGUSD', 'USOIL', 'UKOIL', 'NATGAS', 'COPPER'].includes(ticker);
      const tickSize = isMetalOrOil ? 0.01 : isJpy ? 0.001 : isInr ? 0.0025 : 0.00001;
      return {
        id: key,
        ticker,
        description: `${ticker} (${isMetalOrOil ? 'Commodity' : 'Forex OTC'})`,
        exchange: isMetalOrOil ? 'COMMODITY' : 'FX OTC',
        provider: 'fx_auto',
        market: isMetalOrOil ? 'commodities' : 'forex',
        segment: 'fx',
        currency: isInr ? 'INR' : isJpy ? 'JPY' : 'USD',
        timezone: 'America/New_York',
        calendarId: 'FOREX_OTC',
        tickSize,
        precision: precisionFromTickSize(tickSize),
        lotSize: 1,
        hasVolume: isMetalOrOil,
        supportsOrderbook: false,
        supportsTicks: true,
        feedQuality: 'live_quote_zero_vol',
      };
    }
    if (prefix === 'US') {
      return {
        id: key,
        ticker,
        description: `${ticker} (US Equity / ETF)`,
        exchange: 'US',
        provider: 'us_auto',
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
        feedQuality: 'delayed_eod',
      };
    }
    if (prefix === 'NSE') {
      return nseEquity(ticker, `${ticker} (NSE Equity)`, 500);
    }
    if (prefix === 'BSE') {
      const isIndex = ticker === 'SENSEX';
      return {
        id: key,
        ticker,
        description: isIndex ? 'S&P BSE SENSEX Index' : `${ticker} (BSE Equity)`,
        exchange: 'BSE',
        provider: 'nse_auto',
        market: isIndex ? 'index' : 'india_nse',
        segment: isIndex ? 'index' : 'equity',
        currency: 'INR',
        timezone: 'Asia/Kolkata',
        calendarId: 'NSE',
        tickSize: 0.05,
        precision: 2,
        lotSize: 1,
        hasVolume: !isIndex,
        supportsOrderbook: false,
        supportsTicks: true,
        feedQuality: 'delayed_eod',
      };
    }
    if (prefix === 'MCX') {
      return {
        id: key,
        ticker,
        description: `${ticker} (MCX Commodity Futures)`,
        exchange: 'MCX',
        provider: 'nse_auto',
        market: 'india_mcx',
        segment: 'futures',
        currency: 'INR',
        timezone: 'Asia/Kolkata',
        calendarId: 'MCX',
        tickSize: 1.0,
        precision: 0,
        lotSize: 1,
        hasVolume: true,
        supportsOrderbook: true,
        supportsTicks: true,
        feedQuality: 'delayed_eod',
      };
    }
    if (prefix === 'GLOBAL') {
      return {
        id: key,
        ticker,
        description: `${ticker} (Global Market)`,
        exchange: 'GLOBAL',
        provider: 'global_auto',
        market: ticker.startsWith('^') ? 'index' : ticker.endsWith('=F') ? 'futures' : 'us_equity',
        segment: ticker.startsWith('^') ? 'index' : ticker.endsWith('=F') ? 'futures' : 'equity',
        currency: 'USD',
        timezone: 'UTC',
        calendarId: ticker.endsWith('=X') || ticker.endsWith('=F') ? 'FOREX_OTC' : 'US_EQUITY',
        tickSize: 0.01,
        precision: 2,
        lotSize: 1,
        hasVolume: !ticker.startsWith('^') && !ticker.endsWith('=X'),
        supportsOrderbook: false,
        supportsTicks: true,
        feedQuality: 'delayed_eod',
      };
    }
  }
  return null;
}

export function searchCatalog(
  query: string,
  market: MarketCategory | 'all' = 'all',
  limit = 40,
): SymbolInfo[] {
  const q = query.trim().toLowerCase();
  const matches: Array<{ score: number; sym: SymbolInfo }> = [];

  for (const sym of SYMBOL_CATALOG) {
    if (market !== 'all') {
      if (market === 'forex') {
        if (sym.market !== 'forex' && sym.market !== 'commodities') continue;
      } else if (market === 'india_nse') {
        if (sym.market !== 'india_nse' && sym.market !== 'india_mcx' && sym.calendarId !== 'NSE') continue;
      } else if (sym.market !== market) {
        continue;
      }
    }

    if (!q) {
      matches.push({ score: 1, sym });
      continue;
    }

    const tickerL = sym.ticker.toLowerCase();
    const idL = sym.id.toLowerCase();
    const descL = sym.description.toLowerCase();
    const exL = sym.exchange.toLowerCase();

    let score = 0;
    if (tickerL === q || idL === q) score = 100;
    else if (tickerL.startsWith(q)) score = 80;
    else if (idL.startsWith(q)) score = 70;
    else if (tickerL.includes(q)) score = 50;
    else if (descL.includes(q)) score = 35;
    else if (exL.includes(q)) score = 20;

    if (score > 0) matches.push({ score, sym });
  }

  matches.sort((a, b) => b.score - a.score || a.sym.ticker.localeCompare(b.sym.ticker));
  return matches.slice(0, limit).map((m) => m.sym);
}
