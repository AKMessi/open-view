import type { FeedQualityBadge, OHLCVBar, QuoteTick, Resolution, SymbolInfo } from '@openview/protocol';
import { findSymbolById, searchCatalog } from './catalog.ts';
import type { HistoryRequest, HistoryResponse, IDatafeed, SymbolSearchFilter } from './types.ts';

const BINANCE_INTERVAL_MAP: Record<Resolution, string> = {
  '1S': '1s',
  '5S': '1s',
  '15S': '1s',
  '30S': '1s',
  '1': '1m',
  '3': '3m',
  '5': '5m',
  '15': '15m',
  '30': '30m',
  '45': '15m',
  '60': '1h',
  '120': '2h',
  '240': '4h',
  '1D': '1d',
  '1W': '1w',
  '1M': '1M',
};

const PROACTIVE_ROLLOVER_MS = (23 * 60 + 50) * 60_000; // 23h50m before Binance 24h cap

/**
 * Direct Browser-Compatible Crypto Datafeed (works 100% in Static Mode with zero backend!).
 * - Spot: Binance Public Vision (`data-api.binance.vision` + `wss://data-stream.binance.vision/ws`)
 *   with segment-matched failover to Coinbase Exchange Spot.
 * - Perps: Binance USD-M Futures (`fapi.binance.com` + `wss://fstream.binance.com/ws`)
 *   with segment-matched failover to Hyperliquid Perps (never mixes spot & perp funding basis!).
 */
export class BinanceDirectDatafeed implements IDatafeed {
  readonly id = 'binance_direct';
  readonly name = 'Crypto Direct Public Feeds (Binance .vision / Hyperliquid / Coinbase)';

  async searchSymbols(query: string, filter?: SymbolSearchFilter): Promise<SymbolInfo[]> {
    return searchCatalog(query, filter?.market ?? 'crypto', filter?.limit ?? 40);
  }

  async resolveSymbol(symbolId: string): Promise<SymbolInfo | null> {
    return findSymbolById(symbolId);
  }

  async getBars(req: HistoryRequest): Promise<HistoryResponse> {
    const isPerp = req.symbol.segment === 'perps';
    const rawTicker = req.symbol.ticker.replace(/\.P$/i, '').toUpperCase();
    const interval = BINANCE_INTERVAL_MAP[req.resolution] ?? '15m';
    const limit = Math.min(1000, Math.max(10, req.countBack ?? 500));

    const params = new URLSearchParams({
      symbol: rawTicker,
      interval,
      limit: String(limit),
    });
    if (req.to !== undefined) {
      params.set('endTime', String(Math.floor(req.to)));
    }
    if (req.from !== undefined) {
      params.set('startTime', String(Math.floor(req.from)));
    }

    const primaryBase = isPerp
      ? 'https://fapi.binance.com/fapi/v1/klines'
      : 'https://data-api.binance.vision/api/v3/klines';

    try {
      const res = await fetch(`${primaryBase}?${params.toString()}`, {
        signal: AbortSignal.timeout(4500),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = (await res.json()) as Array<[number, string, string, string, string, string]>;
      const bars: OHLCVBar[] = rows.map((r) => ({
        time: Number(r[0]),
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
        volume: Number(r[5]),
      }));
      return {
        bars,
        noData: bars.length === 0,
        feedQuality: 'live_full_vol',
        providerLabel: isPerp ? 'Binance Perps' : 'Binance Vision',
      };
    } catch {
      // Segment-matched failover: Perps -> Hyperliquid, Spot -> Coinbase
      if (isPerp) {
        return this.fetchHyperliquidFallback(rawTicker, interval, limit, req.to);
      }
      return this.fetchCoinbaseSpotFallback(rawTicker, req.resolution, limit);
    }
  }

  private async fetchHyperliquidFallback(
    rawTicker: string,
    interval: string,
    limit: number,
    endTime?: number,
  ): Promise<HistoryResponse> {
    const coin = rawTicker.replace(/USDT$|USD$/, '');
    const end = endTime ?? Date.now();
    const res = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'candleSnapshot',
        req: {
          coin,
          interval,
          startTime: Math.max(0, end - limit * 3_600_000),
          endTime: end,
        },
      }),
      signal: AbortSignal.timeout(4500),
    });
    if (!res.ok) {
      return { bars: [], noData: true, feedQuality: 'delayed_eod', providerLabel: 'Hyperliquid (Failed)' };
    }
    const rows = (await res.json()) as Array<{ t: number; o: string; h: string; l: string; c: string; v: string }>;
    const bars: OHLCVBar[] = rows.map((r) => ({
      time: r.t,
      open: Number(r.o),
      high: Number(r.h),
      low: Number(r.l),
      close: Number(r.c),
      volume: Number(r.v),
    }));
    return {
      bars,
      noData: bars.length === 0,
      feedQuality: 'live_full_vol',
      providerLabel: 'Hyperliquid Perps (Failover)',
    };
  }

  private async fetchCoinbaseSpotFallback(
    rawTicker: string,
    resolution: Resolution,
    limit: number,
  ): Promise<HistoryResponse> {
    const base = rawTicker.replace(/USDT$|USD$/, '');
    const product = `${base}-USD`;
    const granMap: Partial<Record<Resolution, number>> = {
      '1': 60,
      '5': 300,
      '15': 900,
      '60': 3600,
      '240': 21600,
      '1D': 86400,
    };
    const granularity = granMap[resolution] ?? 900;
    const res = await fetch(
      `https://api.exchange.coinbase.com/products/${encodeURIComponent(product)}/candles?granularity=${granularity}`,
      { signal: AbortSignal.timeout(4500) },
    );
    if (!res.ok) {
      return { bars: [], noData: true, feedQuality: 'delayed_eod', providerLabel: 'Coinbase (Failed)' };
    }
    // Coinbase returns [time_sec, low, high, open, close, volume] newest first
    const rows = (await res.json()) as Array<[number, number, number, number, number, number]>;
    const bars: OHLCVBar[] = rows
      .slice(0, limit)
      .reverse()
      .map((r) => ({
        time: r[0] * 1000,
        open: r[3],
        high: r[2],
        low: r[1],
        close: r[4],
        volume: r[5],
      }));
    return {
      bars,
      noData: bars.length === 0,
      feedQuality: 'live_full_vol',
      providerLabel: 'Coinbase Spot (Failover)',
    };
  }

  subscribeBars(
    symbol: SymbolInfo,
    resolution: Resolution,
    onBar: (bar: OHLCVBar, quality: FeedQualityBadge) => void,
  ): () => void {
    const isPerp = symbol.segment === 'perps';
    const rawTicker = symbol.ticker.replace(/\.P$/i, '').toLowerCase();
    const interval = BINANCE_INTERVAL_MAP[resolution] ?? '15m';
    const wsUrl = isPerp
      ? `wss://fstream.binance.com/ws/${rawTicker}@kline_${interval}`
      : `wss://data-stream.binance.vision/ws/${rawTicker}@kline_${interval}`;

    let closed = false;
    let ws: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let rolloverTimer: ReturnType<typeof setTimeout> | null = null;
    let backoffMs = 800;

    const connect = () => {
      if (closed) return;
      ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        backoffMs = 800;
        // Proactive 23h50m socket rollover before Binance's hard 24h cap
        rolloverTimer = setTimeout(() => {
          ws?.close();
        }, PROACTIVE_ROLLOVER_MS);
      };
      ws.onmessage = (ev) => {
        try {
          const payload = JSON.parse(String(ev.data)) as {
            k?: { t: number; o: string; h: string; l: string; c: string; v: string };
          };
          if (!payload.k) return;
          onBar(
            {
              time: payload.k.t,
              open: Number(payload.k.o),
              high: Number(payload.k.h),
              low: Number(payload.k.l),
              close: Number(payload.k.c),
              volume: Number(payload.k.v),
            },
            'live_full_vol',
          );
        } catch {
          // ignore malformed frames
        }
      };
      ws.onclose = () => {
        if (rolloverTimer) clearTimeout(rolloverTimer);
        if (!closed) {
          retryTimer = setTimeout(connect, backoffMs);
          backoffMs = Math.min(15_000, backoffMs * 1.8);
        }
      };
      ws.onerror = () => {
        ws?.close();
      };
    };

    connect();

    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (rolloverTimer) clearTimeout(rolloverTimer);
      ws?.close();
    };
  }

  subscribeQuotes(symbols: string[], onQuote: (quote: QuoteTick) => void): () => void {
    const spotTickers = symbols
      .filter((s) => s.startsWith('BINANCE:') && !s.endsWith('.P'))
      .map((s) => s.slice('BINANCE:'.length).toLowerCase());
    if (spotTickers.length === 0) return () => {};

    const streams = spotTickers.map((t) => `${t}@miniTicker`).join('/');
    const ws = new WebSocket(`wss://data-stream.binance.vision/stream?streams=${streams}`);
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as {
          data?: { s: string; c: string; o: string; v: string; E: number };
        };
        if (!msg.data) return;
        const last = Number(msg.data.c);
        const open = Number(msg.data.o);
        const change = last - open;
        const changePct = open !== 0 ? (change / open) * 100 : 0;
        onQuote({
          symbol: `BINANCE:${msg.data.s}`,
          last,
          change,
          changePct,
          volume: Number(msg.data.v),
          timestamp: msg.data.E,
          feedQuality: 'live_full_vol',
        });
      } catch {
        // ignore
      }
    };
    return () => ws.close();
  }
}
