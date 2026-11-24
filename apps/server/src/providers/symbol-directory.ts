import { SYMBOL_CATALOG } from '@openview/datafeed-sdk';
import {
  computeNseDynamicTickSize,
  precisionFromTickSize,
  type MarketCategory,
  type SymbolInfo,
} from '@openview/protocol';

export interface SymbolDirectoryStats {
  curated: number;
  binanceSpot: number;
  hyperliquidPerps: number;
  nseEquities: number;
  totalCached: number;
  lastRefreshedAt: number | null;
}

interface YahooSearchQuote {
  symbol?: string;
  shortname?: string;
  longname?: string;
  exchange?: string;
  quoteType?: string;
}

/**
 * Parses official NSE India EQUITY_L.csv master into SymbolInfo records (2,600+ Indian stocks).
 */
export function parseNseEquityMasterCsv(csvText: string): SymbolInfo[] {
  const lines = csvText.split(/\r?\n/);
  const out: SymbolInfo[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    // Handle quoted company names containing commas cleanly
    const cols: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j]!;
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        cols.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    cols.push(cur.trim());

    const ticker = (cols[0] ?? '').toUpperCase();
    const company = cols[1] || ticker;
    const series = (cols[2] ?? '').toUpperCase();
    const lotSize = Math.max(1, Number(cols[5] ?? 1) || 1);
    if (!ticker || !/^[A-Z0-9&-]+$/.test(ticker)) continue;
    if (series && series !== 'EQ' && series !== 'BE' && series !== 'SM' && series !== 'ST') continue;

    const tickSize = computeNseDynamicTickSize(500, 'equity');
    out.push({
      id: `NSE:${ticker}`,
      ticker,
      description: company,
      exchange: 'NSE',
      provider: 'nse_auto',
      market: 'india_nse',
      segment: 'equity',
      currency: 'INR',
      timezone: 'Asia/Kolkata',
      calendarId: 'NSE',
      tickSize,
      precision: precisionFromTickSize(tickSize),
      lotSize,
      hasVolume: true,
      supportsOrderbook: true,
      supportsTicks: true,
      feedQuality: 'delayed_eod',
    });
  }
  return out;
}

/**
 * Parses Binance `.vision` exchangeInfo response into SymbolInfo records (1,300+ active Spot pairs).
 */
export function parseBinanceExchangeInfo(json: {
  symbols?: Array<{
    symbol: string;
    status: string;
    baseAsset: string;
    quoteAsset: string;
    filters?: Array<{ filterType: string; tickSize?: string; stepSize?: string }>;
  }>;
}): SymbolInfo[] {
  const out: SymbolInfo[] = [];
  for (const s of json.symbols ?? []) {
    if (s.status !== 'TRADING') continue;
    const priceFilter = s.filters?.find((f) => f.filterType === 'PRICE_FILTER');
    const lotFilter = s.filters?.find((f) => f.filterType === 'LOT_SIZE');
    const tickSize = Number(priceFilter?.tickSize ?? 0.0001) || 0.0001;
    const lotSize = Number(lotFilter?.stepSize ?? 0.001) || 0.001;
    out.push({
      id: `BINANCE:${s.symbol}`,
      ticker: s.symbol,
      description: `${s.baseAsset} / ${s.quoteAsset} (Binance Spot)`,
      exchange: 'BINANCE',
      provider: 'binance',
      market: 'crypto',
      segment: 'spot',
      currency: s.quoteAsset,
      timezone: 'UTC',
      calendarId: 'CRYPTO',
      tickSize,
      precision: Math.min(8, precisionFromTickSize(tickSize)),
      lotSize,
      hasVolume: true,
      supportsOrderbook: true,
      supportsTicks: true,
      feedQuality: 'live_full_vol',
    });
  }
  return out;
}

/**
 * Parses Hyperliquid `meta` response into active Perpetual Futures SymbolInfo records (230+ perps).
 */
export function parseHyperliquidMeta(json: {
  universe?: Array<{ name: string; szDecimals?: number; maxLeverage?: number; isDelisted?: boolean }>;
}): SymbolInfo[] {
  const out: SymbolInfo[] = [];
  for (const u of json.universe ?? []) {
    if (u.isDelisted || !u.name) continue;
    const coin = u.name.toUpperCase();
    const tickSize = coin === 'BTC' ? 0.5 : coin === 'ETH' ? 0.1 : 0.0001;
    out.push({
      id: `HYPERLIQUID:${coin}-PERP`,
      ticker: `${coin}-PERP`,
      description: `${coin} Perpetual Futures${u.maxLeverage ? ` (${u.maxLeverage}x)` : ''} · Hyperliquid`,
      exchange: 'HYPERLIQUID',
      provider: 'hyperliquid',
      market: 'crypto',
      segment: 'perps',
      currency: 'USD',
      timezone: 'UTC',
      calendarId: 'CRYPTO',
      tickSize,
      precision: precisionFromTickSize(tickSize),
      lotSize: Math.pow(10, -(u.szDecimals ?? 2)),
      hasVolume: true,
      supportsOrderbook: true,
      supportsTicks: true,
      feedQuality: 'live_full_vol',
    });
  }
  return out;
}

/**
 * Normalizes a Yahoo Finance global autocomplete hit into a canonical OpenView SymbolInfo.
 */
export function normalizeYahooSearchQuote(q: YahooSearchQuote): SymbolInfo | null {
  const rawSym = (q.symbol ?? '').trim().toUpperCase();
  if (!rawSym) return null;
  const desc = (q.longname ?? q.shortname ?? rawSym).trim();
  const qt = (q.quoteType ?? '').toUpperCase();
  const ex = (q.exchange ?? '').toUpperCase();

  if (qt === 'OPTION') return null; // Options are handled in the Option Chain drawer

  // Indian NSE (.NS)
  if (rawSym.endsWith('.NS')) {
    const ticker = rawSym.slice(0, -3);
    const tickSize = computeNseDynamicTickSize(500, 'equity');
    return {
      id: `NSE:${ticker}`,
      ticker,
      description: desc,
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

  // Indian BSE (.BO)
  if (rawSym.endsWith('.BO')) {
    const ticker = rawSym.slice(0, -3);
    return {
      id: `BSE:${ticker}`,
      ticker,
      description: desc,
      exchange: 'BSE',
      provider: 'nse_auto',
      market: 'india_nse',
      segment: 'equity',
      currency: 'INR',
      timezone: 'Asia/Kolkata',
      calendarId: 'NSE',
      tickSize: 0.05,
      precision: 2,
      lotSize: 1,
      hasVolume: true,
      supportsOrderbook: false,
      supportsTicks: true,
      feedQuality: 'delayed_eod',
    };
  }

  // Forex (=X)
  if (rawSym.endsWith('=X')) {
    const pair = rawSym.slice(0, -2);
    const isJpy = pair.endsWith('JPY');
    const tickSize = isJpy ? 0.001 : 0.00001;
    return {
      id: `FX:${pair}`,
      ticker: pair,
      description: desc,
      exchange: 'FX OTC',
      provider: 'fx_auto',
      market: 'forex',
      segment: 'fx',
      currency: pair.slice(-3) || 'USD',
      timezone: 'America/New_York',
      calendarId: 'FOREX_OTC',
      tickSize,
      precision: precisionFromTickSize(tickSize),
      lotSize: 1000,
      hasVolume: false,
      supportsOrderbook: false,
      supportsTicks: true,
      feedQuality: 'live_quote_zero_vol',
    };
  }

  // US Equities & ETFs (NASDAQ / NYSE / ARCA / BATS / AMEX)
  const US_EXCHANGES = new Set(['NMS', 'NGM', 'NCM', 'NYQ', 'ASE', 'PCX', 'BTS', 'NAS', 'NASDAQ', 'NYSE']);
  if ((qt === 'EQUITY' || qt === 'ETF') && (US_EXCHANGES.has(ex) || /^[A-Z]{1,5}(-[A-Z])?$/.test(rawSym))) {
    return {
      id: `US:${rawSym}`,
      ticker: rawSym,
      description: desc,
      exchange: ex === 'NMS' || ex === 'NGM' || ex === 'NCM' ? 'NASDAQ' : ex === 'NYQ' ? 'NYSE' : ex || 'US',
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

  // Futures (=F), Indices (^...), and International Stocks
  if (qt === 'FUTURE' || qt === 'INDEX' || qt === 'EQUITY' || qt === 'ETF') {
    const isIndex = qt === 'INDEX' || rawSym.startsWith('^');
    const isFut = qt === 'FUTURE' || rawSym.endsWith('=F');
    return {
      id: `GLOBAL:${rawSym}`,
      ticker: rawSym,
      description: desc,
      exchange: ex || (isFut ? 'FUTURES' : isIndex ? 'INDEX' : 'GLOBAL'),
      provider: 'global_auto',
      market: isFut ? 'futures' : isIndex ? 'index' : 'us_equity',
      segment: isFut ? 'futures' : isIndex ? 'index' : 'equity',
      currency: 'USD',
      timezone: 'UTC',
      calendarId: isFut ? 'FOREX_OTC' : 'US_EQUITY',
      tickSize: 0.01,
      precision: 2,
      lotSize: 1,
      hasVolume: !isIndex,
      supportsOrderbook: false,
      supportsTicks: true,
      feedQuality: 'delayed_eod',
    };
  }

  return null;
}

function matchesMarketTab(sym: SymbolInfo, market: MarketCategory | 'all'): boolean {
  if (market === 'all') return true;
  if (market === 'forex') return sym.market === 'forex' || sym.market === 'commodities';
  if (market === 'india_nse') {
    return sym.market === 'india_nse' || sym.market === 'india_mcx' || sym.calendarId === 'NSE' || sym.calendarId === 'MCX';
  }
  return sym.market === market;
}

/**
 * Universal Multi-Market Symbol Directory:
 * - Warm-caches 4,250+ instruments in RAM on Bridge startup (Binance Spot + Hyperliquid Perps + Official NSE CSV + Curated).
 * - Enriches search queries in real time with Yahoo Finance Global Search (100,000+ US/Global Stocks, ETFs, FX, Futures & Indices).
 */
export class UniversalSymbolDirectory {
  private readonly byId = new Map<string, SymbolInfo>();
  private readonly yahooQueryCache = new Map<string, { ts: number; items: SymbolInfo[] }>();
  private counts = {
    curated: SYMBOL_CATALOG.length,
    binanceSpot: 0,
    hyperliquidPerps: 0,
    nseEquities: 0,
  };
  private lastRefreshedAt: number | null = null;
  private warmPromise: Promise<void> | null = null;

  constructor() {
    for (const sym of SYMBOL_CATALOG) {
      this.byId.set(sym.id.toUpperCase(), sym);
    }
  }

  getStats(): SymbolDirectoryStats {
    return {
      ...this.counts,
      totalCached: this.byId.size,
      lastRefreshedAt: this.lastRefreshedAt,
    };
  }

  warmUp(): Promise<void> {
    if (this.warmPromise && this.lastRefreshedAt && Date.now() - this.lastRefreshedAt < 6 * 3_600_000) {
      return this.warmPromise;
    }
    this.warmPromise = (async () => {
      const [binRes, hlRes, nseRes] = await Promise.allSettled([
        fetch('https://data-api.binance.vision/api/v3/exchangeInfo?permissions=SPOT', {
          signal: AbortSignal.timeout(8000),
        }).then((r) => (r.ok ? r.json() : {})),
        fetch('https://api.hyperliquid.xyz/info', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'meta' }),
          signal: AbortSignal.timeout(6000),
        }).then((r) => (r.ok ? r.json() : {})),
        fetch('https://archives.nseindia.com/content/equities/EQUITY_L.csv', {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) OpenView/0.3' },
          signal: AbortSignal.timeout(8000),
        }).then((r) => (r.ok ? r.text() : '')),
      ]);

      if (binRes.status === 'fulfilled' && binRes.value && typeof binRes.value === 'object') {
        const parsed = parseBinanceExchangeInfo(binRes.value as Parameters<typeof parseBinanceExchangeInfo>[0]);
        this.counts.binanceSpot = parsed.length;
        for (const s of parsed) {
          const k = s.id.toUpperCase();
          if (!this.byId.has(k)) this.byId.set(k, s);
        }
      }

      if (hlRes.status === 'fulfilled' && hlRes.value && typeof hlRes.value === 'object') {
        const parsed = parseHyperliquidMeta(hlRes.value as Parameters<typeof parseHyperliquidMeta>[0]);
        this.counts.hyperliquidPerps = parsed.length;
        for (const s of parsed) {
          const k = s.id.toUpperCase();
          if (!this.byId.has(k)) this.byId.set(k, s);
        }
      }

      if (nseRes.status === 'fulfilled' && typeof nseRes.value === 'string' && nseRes.value.includes('SYMBOL,')) {
        const parsed = parseNseEquityMasterCsv(nseRes.value);
        this.counts.nseEquities = parsed.length;
        for (const s of parsed) {
          const k = s.id.toUpperCase();
          if (!this.byId.has(k)) this.byId.set(k, s);
        }
      }

      this.lastRefreshedAt = Date.now();
    })();
    return this.warmPromise;
  }

  private async queryYahooGlobal(query: string): Promise<SymbolInfo[]> {
    const key = query.toLowerCase();
    const cached = this.yahooQueryCache.get(key);
    if (cached && Date.now() - cached.ts < 300_000) return cached.items;

    try {
      const res = await fetch(
        `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=20&newsCount=0`,
        {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) OpenView/0.3' },
          signal: AbortSignal.timeout(3000),
        },
      );
      if (!res.ok) return [];
      const json = (await res.json()) as { quotes?: YahooSearchQuote[] };
      const items: SymbolInfo[] = [];
      for (const q of json.quotes ?? []) {
        const norm = normalizeYahooSearchQuote(q);
        if (norm) items.push(norm);
      }
      if (this.yahooQueryCache.size > 200) this.yahooQueryCache.clear();
      this.yahooQueryCache.set(key, { ts: Date.now(), items });
      return items;
    } catch {
      return [];
    }
  }

  async search(
    rawQuery: string,
    market: MarketCategory | 'all' = 'all',
    limit = 60,
  ): Promise<{ symbols: SymbolInfo[]; stats: SymbolDirectoryStats }> {
    const q = rawQuery.trim().toLowerCase();
    const scored = new Map<string, { score: number; sym: SymbolInfo }>();

    const scoreAndInsert = (sym: SymbolInfo, bonus = 0) => {
      if (!matchesMarketTab(sym, market)) return;
      const k = sym.id.toUpperCase();
      if (!q) {
        // Empty query: show curated top symbols first, then popular USDT/NSE items
        const isCurated = SYMBOL_CATALOG.some((c) => c.id.toUpperCase() === k);
        const s = isCurated ? 100 : sym.ticker.endsWith('USDT') ? 40 : 20;
        if (!scored.has(k)) scored.set(k, { score: s + bonus, sym });
        return;
      }

      const tickerL = sym.ticker.toLowerCase();
      const idL = sym.id.toLowerCase();
      const descL = sym.description.toLowerCase();
      const exL = sym.exchange.toLowerCase();

      let s = 0;
      if (tickerL === q || idL === q) s = 120;
      else if (tickerL === `${q}usdt` || tickerL === `${q}-perp`) s = 110;
      else if (tickerL.startsWith(q)) s = 85;
      else if (idL.startsWith(q)) s = 75;
      else if (tickerL.includes(q)) s = 55;
      else if (descL.includes(q)) s = 40;
      else if (exL.includes(q)) s = 20;

      if (s > 0) {
        // Slightly boost USDT crypto pairs over exotic BTC/BNB cross pairs when searching coin names
        if (sym.market === 'crypto' && sym.ticker.endsWith('USDT')) s += 8;
        const prev = scored.get(k);
        if (!prev || s + bonus > prev.score) {
          scored.set(k, { score: s + bonus, sym });
        }
      }
    };

    for (const sym of this.byId.values()) {
      scoreAndInsert(sym);
    }

    // Live Yahoo Global autocomplete for US Stocks, ETFs, BSE, Indices, Commodities & Forex
    if (q.length >= 2 && market !== 'crypto') {
      const remote = await this.queryYahooGlobal(rawQuery.trim());
      for (const sym of remote) {
        scoreAndInsert(sym, 4);
      }
    }

    const sorted = [...scored.values()]
      .sort((a, b) => b.score - a.score || a.sym.ticker.localeCompare(b.sym.ticker))
      .slice(0, limit)
      .map((m) => m.sym);

    return {
      symbols: sorted,
      stats: this.getStats(),
    };
  }
}
