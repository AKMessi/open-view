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
import {
  fetchYahooIntradayBars,
  fetchYahooLatestQuote,
  subscribeAlpacaLiveWs,
  subscribeFinnhubLiveWs,
  subscribePolledLiveBar,
  subscribeTiingoFxWs,
} from './live-streams.ts';
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

  private readonly db: DbWorkerClient;
  private readonly vault: CredentialVault;
  private readonly lastBarByKey = new Map<string, OHLCVBar>();

  constructor(db: DbWorkerClient, vault: CredentialVault) {
    this.db = db;
    this.vault = vault;
  }

  private rememberTail(symbolId: string, resolution: Resolution, bars: readonly OHLCVBar[]): void {
    const tail = bars[bars.length - 1];
    if (tail) this.lastBarByKey.set(`${symbolId.toUpperCase()}|${resolution}`, { ...tail });
  }

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

    // 1. CRYPTO: Live Binance .vision / Hyperliquid Perps / Coinbase failover
    if (
      baseSym.market === 'crypto' ||
      baseSym.id.startsWith('BINANCE:') ||
      baseSym.id.startsWith('HYPERLIQUID:')
    ) {
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

      const yahooFx = await fetchYahooIntradayBars(baseSym, resolution);
      if (yahooFx.bars.length > 0) {
        const finalBars =
          resolution === '3' || resolution === '45' || resolution === '120' || resolution === '240'
            ? rollupBars(yahooFx.bars, resolution, baseSym.calendarId)
            : yahooFx.bars;
        this.rememberTail(baseSym.id, resolution, finalBars);
        await this.reconcileAndCache(baseSym, resolution, finalBars);
        return {
          symbolInfo: { ...baseSym, provider: 'yahoo_fx', feedQuality: 'live_quote_zero_vol' },
          bars: finalBars.slice(-count),
          noMoreHistory: true,
          providerLabel: 'Live FX/Gold Public Feed',
        };
      }

      const stooqBars = await this.fetchStooqDaily(baseSym.ticker.toLowerCase(), count, beforeTime);
      if (stooqBars.length > 0) {
        this.rememberTail(baseSym.id, resolution, stooqBars);
        await this.reconcileAndCache(baseSym, '1D', stooqBars);
        return {
          symbolInfo: { ...baseSym, provider: 'stooq_eod', feedQuality: 'delayed_eod' },
          bars: stooqBars,
          noMoreHistory: true,
          providerLabel: 'Stooq FX EOD Baseline',
        };
      }
    }

    // 3. US EQUITIES: Alpaca v2 -> Massive -> Yahoo Real Intraday -> Stooq EOD baseline
    if (baseSym.calendarId === 'US_EQUITY') {
      const alpaca = await this.getProviderCreds('alpaca');
      if (alpaca?.apiKey && alpaca?.apiSecret && this.limiters.get('alpaca')?.tryConsume()) {
        const feed = (alpaca.feed ?? 'iex').toLowerCase() === 'sip' ? 'sip' : 'iex';
        const bars = await this.fetchAlpacaBars(baseSym, resolution, alpaca.apiKey, alpaca.apiSecret, feed, count);
        if (bars.length > 0) {
          this.rememberTail(baseSym.id, resolution, bars);
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
          this.rememberTail(baseSym.id, resolution, bars);
          await this.reconcileAndCache(baseSym, resolution, bars);
          return {
            symbolInfo: { ...baseSym, provider: 'massive', feedQuality: 'live_full_vol' },
            bars,
            noMoreHistory: false,
            providerLabel: 'Massive (Polygon)',
          };
        }
      }

      const yahooUs = await fetchYahooIntradayBars(baseSym, resolution);
      if (yahooUs.bars.length > 0) {
        const finalBars =
          resolution === '3' || resolution === '45' || resolution === '120' || resolution === '240'
            ? rollupBars(yahooUs.bars, resolution, baseSym.calendarId)
            : yahooUs.bars;
        this.rememberTail(baseSym.id, resolution, finalBars);
        await this.reconcileAndCache(baseSym, resolution, finalBars);
        return {
          symbolInfo: { ...baseSym, provider: 'yahoo_us', feedQuality: 'delayed_eod' },
          bars: finalBars.slice(-count),
          noMoreHistory: true,
          providerLabel: 'US Equities Public Intraday',
        };
      }

      const stooqBars = await this.fetchStooqDaily(`${baseSym.ticker.toLowerCase()}.us`, count, beforeTime);
      if (stooqBars.length > 0) {
        this.rememberTail(baseSym.id, resolution, stooqBars);
        await this.reconcileAndCache(baseSym, '1D', stooqBars);
        return {
          symbolInfo: { ...baseSym, provider: 'stooq_eod', feedQuality: 'delayed_eod' },
          bars: stooqBars,
          noMoreHistory: true,
          providerLabel: 'Stooq US EOD Baseline',
        };
      }
    }

    // 4. INDIAN NSE & MCX: Upstox v3 -> Fyers v3 -> Yahoo NSE/MCX Real Intraday
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
          this.rememberTail(baseSym.id, resolution, normalized);
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
          this.rememberTail(baseSym.id, resolution, normalized);
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

      const yahooNse = await fetchYahooIntradayBars(baseSym, resolution);
      if (yahooNse.bars.length > 0) {
        const finalBars =
          resolution === '3' || resolution === '45' || resolution === '120' || resolution === '240'
            ? rollupBars(yahooNse.bars, resolution, baseSym.calendarId)
            : yahooNse.bars;
        this.rememberTail(baseSym.id, resolution, finalBars);
        await this.reconcileAndCache(baseSym, resolution, finalBars);
        return {
          symbolInfo: { ...baseSym, provider: 'nse_public', feedQuality: 'delayed_eod' },
          bars: finalBars.slice(-count),
          noMoreHistory: true,
          providerLabel: 'NSE/MCX Public Intraday',
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
    if (
      sym.market === 'crypto' ||
      sym.id.startsWith('BINANCE:') ||
      sym.id.startsWith('HYPERLIQUID:')
    ) {
      return this.cryptoDirect.subscribeBars(sym, resolution, onBar);
    }

    const seedBar = this.lastBarByKey.get(`${sym.id.toUpperCase()}|${resolution}`);
    let disposed = false;
    let innerUnsub: (() => void) | null = null;

    void (async () => {
      // 1. FOREX & GOLD: Tiingo Live FX WS -> OANDA v20 Live Pricing -> Zero-Key Public Live Feed
      if (sym.calendarId === 'FOREX_OTC') {
        const tiingo = await this.getProviderCreds('tiingo');
        if (disposed) return;
        if (tiingo?.apiKey) {
          innerUnsub = subscribeTiingoFxWs(sym, resolution, tiingo.apiKey, onBar, seedBar);
          return;
        }
        const oanda = await this.getProviderCreds('oanda');
        if (disposed) return;
        if (oanda?.apiToken && oanda?.accountId) {
          const inst = `${sym.ticker.slice(0, 3)}_${sym.ticker.slice(3)}`;
          const base = oanda.environment === 'live' ? 'https://api-fxtrade.oanda.com' : 'https://api-fxpractice.oanda.com';
          innerUnsub = subscribePolledLiveBar(
            sym,
            resolution,
            1500,
            'live_quote_zero_vol',
            async () => {
              const res = await fetch(`${base}/v3/accounts/${encodeURIComponent(oanda.accountId!)}/pricing?instruments=${inst}`, {
                headers: { Authorization: `Bearer ${oanda.apiToken}` },
                signal: AbortSignal.timeout(3500),
              });
              if (!res.ok) return null;
              const j = (await res.json()) as { prices?: Array<{ bids?: Array<{ price: string }>; asks?: Array<{ price: string }> }> };
              const p0 = j.prices?.[0];
              const bid = Number(p0?.bids?.[0]?.price);
              const ask = Number(p0?.asks?.[0]?.price);
              if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
              return { price: (bid + ask) * 0.5, timestamp: Date.now() };
            },
            onBar,
            seedBar,
          );
          return;
        }
      }

      // 2. US EQUITIES: Alpaca Live WS (IEX/SIP) -> Finnhub Live WS -> Zero-Key Public Live Feed
      if (sym.calendarId === 'US_EQUITY') {
        const alpaca = await this.getProviderCreds('alpaca');
        if (disposed) return;
        if (alpaca?.apiKey && alpaca?.apiSecret) {
          const feed = (alpaca.feed ?? 'iex').toLowerCase() === 'sip' ? 'sip' : 'iex';
          innerUnsub = subscribeAlpacaLiveWs(sym, resolution, alpaca.apiKey, alpaca.apiSecret, feed, onBar, seedBar);
          return;
        }
        const finnhub = await this.getProviderCreds('finnhub');
        if (disposed) return;
        if (finnhub?.apiKey) {
          innerUnsub = subscribeFinnhubLiveWs(sym, resolution, finnhub.apiKey, onBar, seedBar);
          return;
        }
      }

      // 3. INDIAN NSE & MCX: Upstox v3 LTP -> Fyers v3 Quotes -> Zero-Key Public Live Feed
      if (sym.calendarId === 'NSE' || sym.calendarId === 'MCX') {
        const upstox = await this.getProviderCreds('upstox');
        if (disposed) return;
        if (upstox?.accessToken) {
          const key =
            sym.ticker === 'NIFTY'
              ? 'NSE_INDEX|Nifty 50'
              : sym.ticker === 'BANKNIFTY'
                ? 'NSE_INDEX|Nifty Bank'
                : `NSE_EQ|${sym.ticker.replace(/1!$/, '')}`;
          const quality: FeedQualityBadge = sym.hasVolume ? 'live_full_vol' : 'live_quote_zero_vol';
          innerUnsub = subscribePolledLiveBar(
            sym,
            resolution,
            1500,
            quality,
            async () => {
              const res = await fetch(`https://api.upstox.com/v3/market-quote/ltp?instrument_key=${encodeURIComponent(key)}`, {
                headers: { Authorization: `Bearer ${upstox.accessToken}`, Accept: 'application/json' },
                signal: AbortSignal.timeout(3500),
              });
              if (!res.ok) return null;
              const j = (await res.json()) as { data?: Record<string, { last_price?: number }> };
              const first = Object.values(j.data ?? {})[0];
              if (!first || typeof first.last_price !== 'number') return null;
              return { price: first.last_price, timestamp: Date.now() };
            },
            onBar,
            seedBar,
          );
          return;
        }

        const fyers = await this.getProviderCreds('fyers');
        if (disposed) return;
        if (fyers?.appId && fyers?.accessToken) {
          const fyersSym =
            sym.ticker === 'NIFTY'
              ? 'NSE:NIFTY50-INDEX'
              : sym.ticker === 'BANKNIFTY'
                ? 'NSE:NIFTYBANK-INDEX'
                : `NSE:${sym.ticker.replace(/1!$/, '')}-EQ`;
          const quality: FeedQualityBadge = sym.hasVolume ? 'live_full_vol' : 'live_quote_zero_vol';
          innerUnsub = subscribePolledLiveBar(
            sym,
            resolution,
            1500,
            quality,
            async () => {
              const res = await fetch(`https://api-t1.fyers.in/data/quotes?symbols=${encodeURIComponent(fyersSym)}`, {
                headers: { Authorization: `${fyers.appId}:${fyers.accessToken}` },
                signal: AbortSignal.timeout(3500),
              });
              if (!res.ok) return null;
              const j = (await res.json()) as { d?: Array<{ v?: { lp?: number; volume?: number } }> };
              const lp = j.d?.[0]?.v?.lp;
              if (typeof lp !== 'number') return null;
              return { price: lp, timestamp: Date.now() };
            },
            onBar,
            seedBar,
          );
          return;
        }
      }

      if (disposed) return;

      // 4. Zero-Key Real Public Live Polling (works immediately out-of-the-box for ALL FX/Gold/US/NSE!)
      const fallbackQuality: FeedQualityBadge =
        sym.calendarId === 'FOREX_OTC' ? 'live_quote_zero_vol' : 'delayed_eod';
      innerUnsub = subscribePolledLiveBar(
        sym,
        resolution,
        4000,
        fallbackQuality,
        async () => {
          const q = await fetchYahooLatestQuote(sym);
          if (!q) return null;
          return { price: q.last, timestamp: q.timestamp };
        },
        onBar,
        seedBar,
      );
    })();

    return () => {
      disposed = true;
      innerUnsub?.();
      innerUnsub = null;
    };
  }

  subscribeLiveQuotes(symbols: string[], onQuote: (q: QuoteTick) => void): () => void {
    const cryptoSyms = symbols.filter(
      (s) => s.startsWith('BINANCE:') || s.startsWith('HYPERLIQUID:'),
    );
    const otherSyms = symbols
      .filter((s) => !s.startsWith('BINANCE:') && !s.startsWith('HYPERLIQUID:'))
      .map((s) => findSymbolById(s))
      .filter((s): s is SymbolInfo => s !== null);

    const unsubCrypto =
      cryptoSyms.length > 0 ? this.cryptoDirect.subscribeQuotes(cryptoSyms, onQuote) : () => {};

    if (otherSyms.length === 0) return unsubCrypto;

    let stopped = false;
    let inFlight = false;

    const pollQuotes = async () => {
      if (stopped || inFlight) return;
      inFlight = true;
      try {
        // Fetch live public quotes in small parallel waves so all 4 markets populate immediately
        const batchSize = 5;
        for (let i = 0; i < otherSyms.length; i += batchSize) {
          if (stopped) break;
          const batch = otherSyms.slice(i, i + batchSize);
          await Promise.all(
            batch.map(async (sym) => {
              const q = await fetchYahooLatestQuote(sym);
              if (!stopped && q) onQuote(q);
            }),
          );
        }
      } finally {
        inFlight = false;
      }
    };

    void pollQuotes();
    const timer = setInterval(() => void pollQuotes(), 6000);

    return () => {
      stopped = true;
      clearInterval(timer);
      unsubCrypto();
    };
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
}
