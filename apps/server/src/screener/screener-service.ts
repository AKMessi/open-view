import { createRequire } from 'node:module';
import { SYMBOL_CATALOG } from '@openview/datafeed-sdk';
import type { FeedQualityBadge, MarketCategory, OHLCVBar } from '@openview/protocol';
import type * as WasmMod from '../wasm-pkg/openview_wasm.js';
import type { MarketDataRouter } from '../providers/market-router.ts';

const require = createRequire(import.meta.url);
const wasm = require('../wasm-pkg/openview_wasm.js') as typeof WasmMod;

export interface ScreenerRow {
  symbol: string;
  ticker: string;
  description: string;
  exchange: string;
  market: MarketCategory;
  currency: string;
  last: number;
  changePct: number;
  volume: number;
  rsi14: number;
  ema20: number;
  ema50: number;
  emaSignal: 'bullish' | 'bearish';
  supertrendDir: 1 | -1;
  atrPct: number;
  bbWidthPct: number;
  feedQuality: FeedQualityBadge;
  updatedAt: number;
}

export interface ScreenerQuery {
  market?: MarketCategory | 'all';
  minRsi?: number;
  maxRsi?: number;
  emaSignal?: 'bullish' | 'bearish' | 'all';
  supertrend?: 'bullish' | 'bearish' | 'all';
  sortBy?: 'changePct' | 'rsi14' | 'atrPct' | 'volume' | 'last';
  sortDir?: 'asc' | 'desc';
  search?: string;
}

export function computeScreenerFeaturesFromBars(
  bars: readonly OHLCVBar[],
): {
  last: number;
  changePct: number;
  volume: number;
  rsi14: number;
  ema20: number;
  ema50: number;
  emaSignal: 'bullish' | 'bearish';
  supertrendDir: 1 | -1;
  atrPct: number;
  bbWidthPct: number;
} {
  const n = bars.length;
  if (n === 0) {
    return {
      last: 0,
      changePct: 0,
      volume: 0,
      rsi14: 50,
      ema20: 0,
      ema50: 0,
      emaSignal: 'bullish',
      supertrendDir: 1,
      atrPct: 0,
      bbWidthPct: 0,
    };
  }

  const high = new Float64Array(n);
  const low = new Float64Array(n);
  const close = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const b = bars[i]!;
    high[i] = b.high;
    low[i] = b.low;
    close[i] = b.close;
  }

  const lastBar = bars[n - 1]!;
  const prevBar = bars[Math.max(0, n - 2)]!;
  const changePct = prevBar.close > 0 ? ((lastBar.close - prevBar.close) / prevBar.close) * 100 : 0;

  const rsiArr = wasm.ta_rsi(close, 14);
  const ema20Arr = wasm.ta_ema(close, 20);
  const ema50Arr = wasm.ta_ema(close, 50);
  const atrArr = wasm.ta_atr(high, low, close, 14);
  const stFlat = wasm.ta_supertrend(high, low, close, 10, 3);
  const bbFlat = wasm.ta_bollinger_bands(close, 20, 2);

  const lastIdx = n - 1;
  const rsi14 = Number.isFinite(rsiArr[lastIdx]) ? rsiArr[lastIdx]! : 50;
  const ema20 = Number.isFinite(ema20Arr[lastIdx]) ? ema20Arr[lastIdx]! : lastBar.close;
  const ema50 = Number.isFinite(ema50Arr[lastIdx]) ? ema50Arr[lastIdx]! : lastBar.close;
  const atr = Number.isFinite(atrArr[lastIdx]) ? atrArr[lastIdx]! : 0;
  const stDirRaw = stFlat[n + lastIdx] ?? 1;
  const bbBasis = bbFlat[lastIdx] ?? lastBar.close;
  const bbUpper = bbFlat[n + lastIdx] ?? lastBar.close;
  const bbLower = bbFlat[2 * n + lastIdx] ?? lastBar.close;

  return {
    last: Number(lastBar.close.toFixed(4)),
    changePct: Number(changePct.toFixed(2)),
    volume: Number(lastBar.volume.toFixed(2)),
    rsi14: Number(rsi14.toFixed(2)),
    ema20: Number(ema20.toFixed(4)),
    ema50: Number(ema50.toFixed(4)),
    emaSignal: ema20 >= ema50 ? 'bullish' : 'bearish',
    supertrendDir: stDirRaw >= 0 ? 1 : -1,
    atrPct: lastBar.close > 0 ? Number(((atr / lastBar.close) * 100).toFixed(2)) : 0,
    bbWidthPct: bbBasis > 0 ? Number((((bbUpper - bbLower) / bbBasis) * 100).toFixed(2)) : 0,
  };
}

export function filterAndSortScreenerRows(
  rows: readonly ScreenerRow[],
  q: ScreenerQuery,
): ScreenerRow[] {
  const searchL = q.search?.trim().toLowerCase() ?? '';
  const filtered = rows.filter((r) => {
    if (q.market && q.market !== 'all') {
      if (q.market === 'forex') {
        if (r.market !== 'forex' && r.market !== 'commodities') return false;
      } else if (q.market === 'india_nse') {
        if (r.market !== 'india_nse' && r.market !== 'india_mcx' && !r.symbol.startsWith('NSE:')) return false;
      } else if (r.market !== q.market) {
        return false;
      }
    }
    if (q.minRsi !== undefined && r.rsi14 < q.minRsi) return false;
    if (q.maxRsi !== undefined && r.rsi14 > q.maxRsi) return false;
    if (q.emaSignal && q.emaSignal !== 'all' && r.emaSignal !== q.emaSignal) return false;
    if (q.supertrend === 'bullish' && r.supertrendDir !== 1) return false;
    if (q.supertrend === 'bearish' && r.supertrendDir !== -1) return false;
    if (
      searchL &&
      !r.ticker.toLowerCase().includes(searchL) &&
      !r.description.toLowerCase().includes(searchL) &&
      !r.symbol.toLowerCase().includes(searchL)
    ) {
      return false;
    }
    return true;
  });

  const sortBy = q.sortBy ?? 'changePct';
  const dir = q.sortDir === 'asc' ? 1 : -1;
  return [...filtered].sort((a, b) => (a[sortBy] - b[sortBy]) * dir);
}

/**
 * Tiered Multi-Market WASM Technical Screener:
 * Pre-computes Rust/WASM features across rate-limit-safe curated universes and caches for 30s
 * so live filter/sort queries execute in < 5ms without blowing exchange API quotas.
 */
export class MultiMarketScreener {
  private readonly router: MarketDataRouter;
  private cache: ScreenerRow[] = [];
  private cacheUpdatedAt = 0;
  private readonly ttlMs = 30_000;

  constructor(router: MarketDataRouter) {
    this.router = router;
  }

  async scan(query: ScreenerQuery = {}, forceRefresh = false): Promise<{
    rows: ScreenerRow[];
    scannedCount: number;
    elapsedMs: number;
    cached: boolean;
  }> {
    const t0 = performance.now();
    const isFresh = !forceRefresh && this.cache.length > 0 && Date.now() - this.cacheUpdatedAt < this.ttlMs;

    if (!isFresh) {
      // Rate-limit-safe curated scan across all 4 markets
      const universe = SYMBOL_CATALOG.slice(0, 32);
      const nextRows: ScreenerRow[] = [];

      await Promise.all(
        universe.map(async (sym) => {
          try {
            const hist = await this.router.getHistory(sym.id, '60', 120);
            const feats = computeScreenerFeaturesFromBars(hist.bars);
            nextRows.push({
              symbol: sym.id,
              ticker: sym.ticker,
              description: sym.description,
              exchange: sym.exchange,
              market: sym.market,
              currency: sym.currency,
              ...feats,
              feedQuality: hist.symbolInfo.feedQuality,
              updatedAt: Date.now(),
            });
          } catch {
            // Skip transient symbol fetch errors cleanly
          }
        }),
      );

      this.cache = nextRows;
      this.cacheUpdatedAt = Date.now();
    }

    const rows = filterAndSortScreenerRows(this.cache, query);
    return {
      rows,
      scannedCount: this.cache.length,
      elapsedMs: Number((performance.now() - t0).toFixed(2)),
      cached: isFresh,
    };
  }
}
