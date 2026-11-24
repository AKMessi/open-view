import { generateSyntheticBars } from '@openview/chart-engine/model';
import {
  BinanceDirectDatafeed,
  detectCorporateActionDivergence,
  findSymbolById,
  parseCsvBars,
  rollupBars,
} from '@openview/datafeed-sdk';
import type { FeedQualityBadge, OHLCVBar, QuoteTick, Resolution, SymbolInfo } from '@openview/protocol';
import type { CredentialVault, SealedSecretRecord } from '../security/vault.ts';
import type { DbWorkerClient } from '../workers/db-client.ts';
import { TokenBucketRateLimiter } from './rate-limiter.ts';

export type ProviderId =
  | 'tiingo'
  | 'twelvedata'
  | 'oanda'
  | 'alpaca'
  | 'finnhub'
  | 'massive'
  | 'upstox'
  | 'fyers'
  | 'dhan'
  | 'kite';

export interface ProviderMetadata {
  id: ProviderId;
  name: string;
  markets: string[];
  costTier: string;
  regionNote?: string;
  fields: Array<{ key: string; label: string; secret: boolean; placeholder?: string }>;
}

export const SUPPORTED_PROVIDERS: readonly ProviderMetadata[] = [
  {
    id: 'tiingo',
    name: 'Tiingo FX & EOD',
    markets: ['Forex', 'Gold (XAUUSD)', 'US EOD'],
    costTier: 'Free ($0 · 50 req/hr · Live FX WS)',
    regionNote: 'Global (India-friendly)',
    fields: [{ key: 'apiKey', label: 'API Token', secret: true, placeholder: 'Tiingo token' }],
  },
  {
    id: 'upstox',
    name: 'Upstox API v3',
    markets: ['India NSE', 'BSE', 'F&O', 'MCX'],
    costTier: 'Free (₹0 · Live Protobuf WS + V3 History + Greeks)',
    regionNote: 'India · Daily OAuth Token',
    fields: [{ key: 'accessToken', label: 'V3 Access Token', secret: true, placeholder: 'Bearer access token' }],
  },
  {
    id: 'fyers',
    name: 'Fyers API v3',
    markets: ['India NSE', 'F&O', 'MCX'],
    costTier: 'Free (₹0 · Live WS + Multi-Year 1m History)',
    regionNote: 'India · Daily OAuth Token',
    fields: [
      { key: 'appId', label: 'App ID', secret: false, placeholder: 'XXXXXXXX-100' },
      { key: 'accessToken', label: 'Access Token', secret: true },
    ],
  },
  {
    id: 'alpaca',
    name: 'Alpaca Markets v2',
    markets: ['US Stocks', 'ETFs'],
    costTier: 'Free IEX (~2.5% Vol) / Paid SIP (100% Vol)',
    fields: [
      { key: 'apiKey', label: 'API Key ID', secret: false },
      { key: 'apiSecret', label: 'API Secret Key', secret: true },
      { key: 'feed', label: 'Feed (iex or sip)', secret: false, placeholder: 'iex' },
    ],
  },
  {
    id: 'massive',
    name: 'Massive (formerly Polygon.io)',
    markets: ['US Stocks', 'Forex', 'Crypto'],
    costTier: 'BYOK (Starter / Developer / Commercial)',
    fields: [{ key: 'apiKey', label: 'API Key', secret: true }],
  },
  {
    id: 'finnhub',
    name: 'Finnhub (Live WS + Paired REST)',
    markets: ['US Stocks'],
    costTier: 'Free WS Quotes (REST paired with Alpaca/Stooq)',
    fields: [{ key: 'apiKey', label: 'API Key', secret: true }],
  },
  {
    id: 'dhan',
    name: 'DhanHQ v2',
    markets: ['India NSE', 'F&O', 'MCX'],
    costTier: 'Free Execution · ₹499/mo Data API',
    fields: [
      { key: 'clientId', label: 'Client ID', secret: false },
      { key: 'accessToken', label: 'Access Token', secret: true },
    ],
  },
  {
    id: 'kite',
    name: 'Zerodha Kite Connect',
    markets: ['India NSE', 'BSE', 'F&O', 'MCX'],
    costTier: '₹500/mo Connect (Live Binary WS + History)',
    fields: [
      { key: 'apiKey', label: 'API Key', secret: false },
      { key: 'accessToken', label: 'Daily Access Token', secret: true },
    ],
  },
  {
    id: 'oanda',
    name: 'OANDA v20',
    markets: ['Forex', 'Gold (XAUUSD)', 'Oil'],
    costTier: 'Free Practice / Live Account',
    regionNote: 'Global / Non-India (RBI FEMA Alert List)',
    fields: [
      { key: 'accountId', label: 'Account ID', secret: false },
      { key: 'apiToken', label: 'v20 Bearer Token', secret: true },
      { key: 'environment', label: 'practice or live', secret: false, placeholder: 'practice' },
    ],
  },
  {
    id: 'twelvedata',
    name: 'Twelve Data',
    markets: ['Forex', 'Gold', 'US Stocks'],
    costTier: 'Free 800 req/day REST',
    fields: [{ key: 'apiKey', label: 'API Key', secret: true }],
  },
];

export interface MarketHistoryResult {
  symbolInfo: SymbolInfo;
  bars: OHLCVBar[];
  noMoreHistory: boolean;
  providerLabel: string;
}

/**
 * Multi-Market Bridge Router:
 * Routes Crypto, Forex/Gold, US Stocks, and Indian NSE/MCX cleanly to the highest-priority
 * configured Vault provider (or zero-key baseline), caches bars in off-main-thread SQLite,
 * enforces per-provider token buckets, and runs 5-bar corporate-action tail reconciliation.
 */
export class MarketDataRouter {
  private readonly cryptoDirect = new BinanceDirectDatafeed();
  private readonly limiters = new Map<string, TokenBucketRateLimiter>([
    ['tiingo', new TokenBucketRateLimiter(45, 3_600_000)], // Strict safety margin under 50 req/hr
    ['twelvedata', new TokenBucketRateLimiter(7, 60_000)],
    ['kite', new TokenBucketRateLimiter(3, 1_000)],
    ['alpaca', new TokenBucketRateLimiter(180, 60_000)],
    ['upstox', new TokenBucketRateLimiter(25, 1_000)],
    ['fyers', new TokenBucketRateLimiter(10, 1_000)],
  ]);

  constructor(
    private readonly db: DbWorkerClient,
    private readonly vault: CredentialVault,
  ) {}

  private async getProviderCreds(provider: ProviderId): Promise<Record<string, string> | null> {
    const row = await this.db.getVaultSecret(provider);
    if (!row) return null;
    try {
      const sealed = JSON.parse(row.record_json) as SealedSecretRecord;
      const plain = this.vault.decryptSecret(sealed);
      return JSON.parse(plain) as Record<string, string>;
    } catch {
      return null;
    }
  }

  async getHistory(
    symbolId: string,
    resolution: Resolution,
    count = 300,
    beforeTime?: number,
  ): Promise<MarketHistoryResult> {
    const baseSym = findSymbolById(symbolId);
    if (!baseSym) {
      throw new Error(`Unknown symbol: ${symbolId}`);
    }

    // 1. CRYPTO: Live Binance .vision / Hyperliquid / Coinbase failover
    if (baseSym.market === 'crypto' || baseSym.id.startsWith('BINANCE:')) {
      const res = await this.cryptoDirect.getBars({
        symbol: baseSym,
        resolution,
        countBack: count,
        ...(beforeTime !== undefined ? { to: beforeTime - 1 } : {}),
      });
      if (res.bars.length > 0) {
        await this.reconcileAndCache(baseSym, resolution, res.bars);
        return {
          symbolInfo: { ...baseSym, feedQuality: res.feedQuality },
          bars: res.bars,
          noMoreHistory: res.bars.length < 10,
          providerLabel: res.providerLabel,
        };
      }
    }

    // 2. FOREX & GOLD: Tiingo FX (1m cached + local rollup!) -> OANDA v20 -> Stooq EOD baseline
    if (baseSym.calendarId === 'FOREX_OTC') {
      const tiingo = await this.getProviderCreds('tiingo');
      if (tiingo?.apiKey && this.limiters.get('tiingo')?.tryConsume()) {
        const bars = await this.fetchTiingoFx(baseSym, resolution, tiingo.apiKey);
        if (bars.length > 0) {
          await this.reconcileAndCache(baseSym, resolution, bars);
          return {
            symbolInfo: { ...baseSym, provider: 'tiingo', feedQuality: 'live_quote_zero_vol' },
            bars,
            noMoreHistory: false,
            providerLabel: 'Tiingo FX (Live/1m Rollup)',
          };
        }
      }

      const oanda = await this.getProviderCreds('oanda');
      if (oanda?.apiToken) {
        const bars = await this.fetchOandaCandles(baseSym, resolution, oanda.apiToken, oanda.environment ?? 'practice', count);
        if (bars.length > 0) {
          await this.reconcileAndCache(baseSym, resolution, bars);
          return {
            symbolInfo: { ...baseSym, provider: 'oanda', feedQuality: 'live_quote_zero_vol' },
            bars,
            noMoreHistory: false,
            providerLabel: 'OANDA v20',
          };
        }
      }

      const stooqBars = await this.fetchStooqDaily(baseSym.ticker.toLowerCase(), count, beforeTime);
      if (stooqBars.length > 0) {
        await this.reconcileAndCache(baseSym, '1D', stooqBars);
        return {
          symbolInfo: { ...baseSym, provider: 'stooq_eod', feedQuality: 'delayed_eod' },
          bars: stooqBars,
          noMoreHistory: true,
          providerLabel: 'Stooq FX EOD Baseline',
        };
      }
    }

    // 3. US EQUITIES: Alpaca v2 -> Massive -> Stooq EOD baseline
    if (baseSym.calendarId === 'US_EQUITY') {
      const alpaca = await this.getProviderCreds('alpaca');
      if (alpaca?.apiKey && alpaca?.apiSecret && this.limiters.get('alpaca')?.tryConsume()) {
        const feed = (alpaca.feed ?? 'iex').toLowerCase() === 'sip' ? 'sip' : 'iex';
        const bars = await this.fetchAlpacaBars(baseSym, resolution, alpaca.apiKey, alpaca.apiSecret, feed, count);
        if (bars.length > 0) {
          await this.reconcileAndCache(baseSym, resolution, bars);
          const quality: FeedQualityBadge = feed === 'sip' ? 'live_full_vol' : 'live_subset_vol';
          return {
            symbolInfo: { ...baseSym, provider: 'alpaca', feedQuality: quality },
            bars,
            noMoreHistory: false,
            providerLabel: feed === 'sip' ? 'Alpaca SIP (100% Vol)' : 'Alpaca IEX (~2.5% Vol)',
          };
        }
      }

      const massive = await this.getProviderCreds('massive');
      if (massive?.apiKey) {
        const bars = await this.fetchMassiveBars(baseSym, resolution, massive.apiKey, count);
        if (bars.length > 0) {
          await this.reconcileAndCache(baseSym, resolution, bars);
          return {
            symbolInfo: { ...baseSym, provider: 'massive', feedQuality: 'live_full_vol' },
            bars,
            noMoreHistory: false,
            providerLabel: 'Massive (Polygon)',
          };
        }
      }

      const stooqBars = await this.fetchStooqDaily(`${baseSym.ticker.toLowerCase()}.us`, count, beforeTime);
      if (stooqBars.length > 0) {
        await this.reconcileAndCache(baseSym, '1D', stooqBars);
        return {
          symbolInfo: { ...baseSym, provider: 'stooq_eod', feedQuality: 'delayed_eod' },
          bars: stooqBars,
          noMoreHistory: true,
          providerLabel: 'Stooq US EOD Baseline',
        };
      }
    }

    // 4. INDIAN NSE & MCX: Upstox v3 -> Fyers v3 -> Yahoo/Stooq NSE EOD baseline
    if (baseSym.calendarId === 'NSE' || baseSym.calendarId === 'MCX') {
      const upstox = await this.getProviderCreds('upstox');
      if (upstox?.accessToken && this.limiters.get('upstox')?.tryConsume()) {
        const bars = await this.fetchUpstoxV3Bars(baseSym, resolution, upstox.accessToken);
        if (bars.length > 0) {
          // Seam normalization: build 60m/240m from 1m/5m onto exact 09:15 IST buckets
          const normalized =
            resolution === '60' || resolution === '240'
              ? rollupBars(bars, resolution, baseSym.calendarId)
              : bars;
          await this.reconcileAndCache(baseSym, resolution, normalized);
          return {
            symbolInfo: {
              ...baseSym,
              provider: 'upstox_v3',
              feedQuality: baseSym.hasVolume ? 'live_full_vol' : 'live_quote_zero_vol',
            },
            bars: normalized,
            noMoreHistory: false,
            providerLabel: 'Upstox API v3 (Live NSE)',
          };
        }
      }

      const fyers = await this.getProviderCreds('fyers');
      if (fyers?.appId && fyers?.accessToken && this.limiters.get('fyers')?.tryConsume()) {
        const bars = await this.fetchFyersV3Bars(baseSym, resolution, fyers.appId, fyers.accessToken);
        if (bars.length > 0) {
          const normalized =
            resolution === '60' || resolution === '240'
              ? rollupBars(bars, resolution, baseSym.calendarId)
              : bars;
          await this.reconcileAndCache(baseSym, resolution, normalized);
          return {
            symbolInfo: {
              ...baseSym,
              provider: 'fyers_v3',
              feedQuality: baseSym.hasVolume ? 'live_full_vol' : 'live_quote_zero_vol',
            },
            bars: normalized,
            noMoreHistory: false,
            providerLabel: 'Fyers API v3 (Live NSE)',
          };
        }
      }

      const yahooBars = await this.fetchYahooPublicFallback(baseSym, resolution);
      if (yahooBars.length > 0) {
        await this.reconcileAndCache(baseSym, resolution, yahooBars);
        return {
          symbolInfo: { ...baseSym, provider: 'nse_delayed', feedQuality: 'delayed_eod' },
          bars: yahooBars,
          noMoreHistory: true,
          providerLabel: 'NSE Delayed/EOD Baseline',
        };
      }
    }

    // 5. SQLite local cache fallback (offline resilience)
    const cached = await this.db.getCachedBars(baseSym.id, resolution, count, beforeTime);
    if (cached.length > 0) {
      return {
        symbolInfo: { ...baseSym, feedQuality: 'delayed_eod' },
        bars: cached,
        noMoreHistory: true,
        providerLabel: 'Local SQLite Cache',
      };
    }

    // 6. Deterministic offline demo fallback so the terminal NEVER crashes without internet
    const demoBars = generateSyntheticBars(baseSym, resolution, Math.min(count, 500), baseSym.id.length * 17);
    return {
      symbolInfo: { ...baseSym, feedQuality: 'delayed_eod' },
      bars: demoBars,
      noMoreHistory: true,
      providerLabel: 'Offline Synthetic Fallback',
    };
  }

  subscribeLiveBars(
    symbolId: string,
    resolution: Resolution,
    onBar: (bar: OHLCVBar, quality: FeedQualityBadge) => void,
  ): () => void {
    const sym = findSymbolById(symbolId);
    if (!sym) return () => {};
    if (sym.market === 'crypto' || sym.id.startsWith('BINANCE:')) {
      return this.cryptoDirect.subscribeBars(sym, resolution, onBar);
    }
    return () => {};
  }

  subscribeLiveQuotes(symbols: string[], onQuote: (q: QuoteTick) => void): () => void {
    return this.cryptoDirect.subscribeQuotes(symbols, onQuote);
  }

  private async reconcileAndCache(
    symbol: SymbolInfo,
    resolution: Resolution,
    freshBars: OHLCVBar[],
  ): Promise<void> {
    if (freshBars.length === 0) return;
    if (resolution === '1D' && (symbol.calendarId === 'US_EQUITY' || symbol.calendarId === 'NSE')) {
      const existingTail = await this.db.getCachedBars(symbol.id, resolution, 12);
      const check = detectCorporateActionDivergence(existingTail, freshBars, symbol.tickSize);
      if (check.diverged) {
        await this.db.invalidateCachedBars(symbol.id);
      }
    }
    await this.db.putBarsBatch(symbol.id, resolution, freshBars.slice(-1000));
  }

  private async fetchTiingoFx(symbol: SymbolInfo, resolution: Resolution, token: string): Promise<OHLCVBar[]> {
    try {
      const ticker = symbol.ticker.toLowerCase();
      // Always pull 1m (or 1D for daily) and roll up locally to conserve Tiingo's 50 req/hr quota!
      const isDaily = resolution === '1D' || resolution === '1W' || resolution === '1M';
      const freq = isDaily ? '1day' : '1min';
      const lookbackDays = isDaily ? 365 : 5;
      const start = new Date(Date.now() - lookbackDays * 86_400_000).toISOString().slice(0, 10);
      const url = `https://api.tiingo.com/tiingo/fx/${encodeURIComponent(ticker)}/prices?startDate=${start}&resampleFreq=${freq}`;
      const res = await fetch(url, {
        headers: { Authorization: `Token ${token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return [];
      const rows = (await res.json()) as Array<{ date: string; open: number; high: number; low: number; close: number }>;
      const raw: OHLCVBar[] = rows.map((r) => ({
        time: Date.parse(r.date),
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: 0,
      }));
      if (!isDaily && resolution !== '1') {
        return rollupBars(raw, resolution, 'FOREX_OTC');
      }
      return raw;
    } catch {
      return [];
    }
  }

  private async fetchOandaCandles(
    symbol: SymbolInfo,
    resolution: Resolution,
    token: string,
    env: string,
    count: number,
  ): Promise<OHLCVBar[]> {
    try {
      const inst = `${symbol.ticker.slice(0, 3)}_${symbol.ticker.slice(3)}`;
      const granMap: Partial<Record<Resolution, string>> = {
        '1': 'M1', '5': 'M5', '15': 'M15', '30': 'M30', '60': 'H1', '240': 'H4', '1D': 'D', '1W': 'W',
      };
      const gran = granMap[resolution] ?? 'M15';
      const base = env === 'live' ? 'https://api-fxtrade.oanda.com' : 'https://api-fxpractice.oanda.com';
      const res = await fetch(
        `${base}/v3/instruments/${inst}/candles?granularity=${gran}&count=${Math.min(count, 500)}&price=M`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!res.ok) return [];
      const data = (await res.json()) as {
        candles?: Array<{ time: string; volume: number; mid: { o: string; h: string; l: string; c: string } }>;
      };
      return (data.candles ?? []).map((c) => ({
        time: Date.parse(c.time),
        open: Number(c.mid.o),
        high: Number(c.mid.h),
        low: Number(c.mid.l),
        close: Number(c.mid.c),
        volume: c.volume,
      }));
    } catch {
      return [];
    }
  }

  private async fetchAlpacaBars(
    symbol: SymbolInfo,
    resolution: Resolution,
    apiKey: string,
    apiSecret: string,
    feed: 'iex' | 'sip',
    count: number,
  ): Promise<OHLCVBar[]> {
    try {
      const tfMap: Partial<Record<Resolution, string>> = {
        '1': '1Min', '5': '5Min', '15': '15Min', '30': '30Min', '60': '1Hour', '240': '4Hour', '1D': '1Day', '1W': '1Week',
      };
      const tf = tfMap[resolution] ?? '15Min';
      const lookbackDays = resolution === '1D' || resolution === '1W' ? 730 : 30;
      const start = new Date(Date.now() - lookbackDays * 86_400_000).toISOString();
      const url = `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol.ticker)}/bars?timeframe=${tf}&start=${encodeURIComponent(start)}&limit=${Math.min(count, 1000)}&feed=${feed}&adjustment=split`;
      const res = await fetch(url, {
        headers: {
          'APCA-API-KEY-ID': apiKey,
          'APCA-API-SECRET-KEY': apiSecret,
        },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as {
        bars?: Array<{ t: string; o: number; h: number; l: number; c: number; v: number }>;
      };
      return (data.bars ?? []).map((b) => ({
        time: Date.parse(b.t),
        open: b.o,
        high: b.h,
        low: b.l,
        close: b.c,
        volume: b.v,
      }));
    } catch {
      return [];
    }
  }

  private async fetchMassiveBars(
    symbol: SymbolInfo,
    resolution: Resolution,
    apiKey: string,
    count: number,
  ): Promise<OHLCVBar[]> {
    try {
      const spanMap: Partial<Record<Resolution, [number, string]>> = {
        '1': [1, 'minute'], '5': [5, 'minute'], '15': [15, 'minute'], '60': [1, 'hour'], '1D': [1, 'day'],
      };
      const [mult, span] = spanMap[resolution] ?? [1, 'day'];
      const to = new Date().toISOString().slice(0, 10);
      const from = new Date(Date.now() - (span === 'day' ? 730 : 30) * 86_400_000).toISOString().slice(0, 10);
      const url = `https://api.massive.com/v2/aggs/ticker/${encodeURIComponent(symbol.ticker)}/range/${mult}/${span}/${from}/${to}?adjusted=true&sort=asc&limit=${Math.min(count, 5000)}&apiKey=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return [];
      const data = (await res.json()) as {
        results?: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }>;
      };
      return (data.results ?? []).map((r) => ({
        time: r.t,
        open: r.o,
        high: r.h,
        low: r.l,
        close: r.c,
        volume: r.v,
      }));
    } catch {
      return [];
    }
  }

  private async fetchUpstoxV3Bars(
    symbol: SymbolInfo,
    resolution: Resolution,
    accessToken: string,
  ): Promise<OHLCVBar[]> {
    try {
      // Upstox API V3: /v3/historical-candle/:instrument_key/:unit/:interval/:to_date/:from_date
      const unitInterval: Record<string, [string, string]> = {
        '1': ['minutes', '1'],
        '5': ['minutes', '5'],
        '15': ['minutes', '15'],
        '30': ['minutes', '30'],
        '60': ['minutes', '5'], // Seam-normalized onto 09:15 IST via rollupBars!
        '240': ['minutes', '15'],
        '1D': ['days', '1'],
        '1W': ['weeks', '1'],
        '1M': ['months', '1'],
      };
      const [unit, interval] = unitInterval[resolution] ?? ['days', '1'];
      const instrumentKey =
        symbol.ticker === 'NIFTY'
          ? 'NSE_INDEX|Nifty 50'
          : symbol.ticker === 'BANKNIFTY'
            ? 'NSE_INDEX|Nifty Bank'
            : `NSE_EQ|${symbol.ticker}`;
      const toDate = new Date().toISOString().slice(0, 10);
      const fromDate = new Date(Date.now() - (unit === 'minutes' ? 14 : 365) * 86_400_000).toISOString().slice(0, 10);
      const url = `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(instrumentKey)}/${unit}/${interval}/${toDate}/${fromDate}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as {
        data?: { candles?: Array<[string, number, number, number, number, number]> };
      };
      const candles = data.data?.candles ?? [];
      return candles
        .map((c) => ({
          time: Date.parse(c[0]),
          open: c[1],
          high: c[2],
          low: c[3],
          close: c[4],
          volume: c[5],
        }))
        .sort((a, b) => a.time - b.time);
    } catch {
      return [];
    }
  }

  private async fetchFyersV3Bars(
    symbol: SymbolInfo,
    resolution: Resolution,
    appId: string,
    accessToken: string,
  ): Promise<OHLCVBar[]> {
    try {
      const fyersSym =
        symbol.ticker === 'NIFTY'
          ? 'NSE:NIFTY50-INDEX'
          : symbol.ticker === 'BANKNIFTY'
            ? 'NSE:NIFTYBANK-INDEX'
            : `NSE:${symbol.ticker}-EQ`;
      const resCode =
        resolution === '1D' ? 'D' : resolution === '60' || resolution === '240' ? '5' : resolution;
      const to = new Date().toISOString().slice(0, 10);
      const from = new Date(Date.now() - (resCode === 'D' ? 365 : 20) * 86_400_000).toISOString().slice(0, 10);
      const params = new URLSearchParams({
        symbol: fyersSym,
        resolution: resCode,
        date_format: '1',
        range_from: from,
        range_to: to,
        cont_flag: '1',
      });
      const res = await fetch(`https://api-t1.fyers.in/data/history?${params.toString()}`, {
        headers: { Authorization: `${appId}:${accessToken}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as {
        candles?: Array<[number, number, number, number, number, number]>;
      };
      return (data.candles ?? []).map((c) => ({
        time: c[0] * 1000,
        open: c[1],
        high: c[2],
        low: c[3],
        close: c[4],
        volume: c[5],
      }));
    } catch {
      return [];
    }
  }

  private async fetchStooqDaily(stooqTicker: string, count: number, beforeTime?: number): Promise<OHLCVBar[]> {
    try {
      const res = await fetch(`https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqTicker)}&i=d`, {
        signal: AbortSignal.timeout(4500),
      });
      if (!res.ok) return [];
      const text = await res.text();
      if (!text.includes('Date,Open')) return [];
      let bars = parseCsvBars(text);
      if (beforeTime !== undefined) {
        bars = bars.filter((b) => b.time < beforeTime);
      }
      return bars.slice(-count);
    } catch {
      return [];
    }
  }

  private async fetchYahooPublicFallback(symbol: SymbolInfo, resolution: Resolution): Promise<OHLCVBar[]> {
    try {
      const ySym =
        symbol.ticker === 'NIFTY'
          ? '^NSEI'
          : symbol.ticker === 'BANKNIFTY'
            ? '^NSEBANK'
            : symbol.ticker.endsWith('1!')
              ? symbol.ticker === 'NIFTY1!'
                ? '^NSEI'
                : '^NSEBANK'
              : `${symbol.ticker}.NS`;
      const interval =
        resolution === '1'
          ? '1m'
          : resolution === '5'
            ? '5m'
            : resolution === '15'
              ? '15m'
              : resolution === '60'
                ? '60m'
                : '1d';
      const range = interval === '1d' ? '2y' : interval === '1m' ? '5d' : '30d';
      const res = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySym)}?interval=${interval}&range=${range}`,
        {
          headers: { 'User-Agent': 'OpenView/0.1' },
          signal: AbortSignal.timeout(4500),
        },
      );
      if (!res.ok) return [];
      const json = (await res.json()) as {
        chart?: {
          result?: Array<{
            timestamp?: number[];
            indicators?: {
              quote?: Array<{
                open?: Array<number | null>;
                high?: Array<number | null>;
                low?: Array<number | null>;
                close?: Array<number | null>;
                volume?: Array<number | null>;
              }>;
            };
          }>;
        };
      };
      const r0 = json.chart?.result?.[0];
      const ts = r0?.timestamp ?? [];
      const q = r0?.indicators?.quote?.[0];
      if (!q || ts.length === 0) return [];
      const out: OHLCVBar[] = [];
      for (let i = 0; i < ts.length; i++) {
        const o = q.open?.[i];
        const h = q.high?.[i];
        const l = q.low?.[i];
        const c = q.close?.[i];
        const v = q.volume?.[i] ?? 0;
        if (o == null || h == null || l == null || c == null) continue;
        out.push({
          time: ts[i]! * 1000,
          open: o,
          high: h,
          low: l,
          close: c,
          volume: symbol.hasVolume ? v : 0,
        });
      }
      return out;
    } catch {
      return [];
    }
  }
}
