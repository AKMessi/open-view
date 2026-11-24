import { SessionCalendar } from '@openview/chart-engine/model';
import type {
  FeedQualityBadge,
  OHLCVBar,
  QuoteTick,
  Resolution,
  SymbolInfo,
} from '@openview/protocol';
import WebSocket from 'ws';

const calendar = new SessionCalendar();

export function toYahooSymbol(symbol: SymbolInfo): string {
  const t = symbol.ticker.toUpperCase();
  if (symbol.id.startsWith('GLOBAL:')) {
    return symbol.id.slice('GLOBAL:'.length);
  }
  if (symbol.id.startsWith('BSE:')) {
    if (t === 'SENSEX') return '^BSESN';
    return `${t}.BO`;
  }
  if (symbol.calendarId === 'FOREX_OTC') {
    if (t === 'XAUUSD') return 'GC=F';
    if (t === 'XAGUSD') return 'SI=F';
    if (t === 'USOIL') return 'CL=F';
    if (t === 'UKOIL') return 'BZ=F';
    if (t === 'NATGAS') return 'NG=F';
    if (t === 'COPPER') return 'HG=F';
    if (t === 'DXY') return 'DX-Y.NYB';
    return `${t}=X`;
  }
  if (symbol.calendarId === 'US_EQUITY') {
    if (t === 'SPX') return '^GSPC';
    if (t === 'NDX') return '^NDX';
    if (t === 'VIX') return '^VIX';
    return t;
  }
  if (symbol.calendarId === 'MCX') {
    if (t.startsWith('GOLD')) return 'GC=F';
    if (t.startsWith('CRUDEOIL')) return 'CL=F';
    if (t.startsWith('SILVER')) return 'SI=F';
    if (t.startsWith('NATURALGAS')) return 'NG=F';
    if (t.startsWith('COPPER')) return 'HG=F';
    return `${t.replace(/1!$/, '')}.NS`;
  }
  // Indian NSE
  if (t === 'NIFTY' || t === 'NIFTY1!') return '^NSEI';
  if (t === 'BANKNIFTY' || t === 'BANKNIFTY1!') return '^NSEBANK';
  if (t === 'FINNIFTY') return 'NIFTY_FIN_SERVICE.NS';
  if (t === 'INDIAVIX') return '^INDIAVIX';
  return `${t.replace(/1!$/, '')}.NS`;
}

export async function fetchYahooIntradayBars(
  symbol: SymbolInfo,
  resolution: Resolution,
): Promise<{ bars: OHLCVBar[]; metaPrice?: number; prevClose?: number }> {
  try {
    const ySym = toYahooSymbol(symbol);
    const intervalMap: Partial<Record<Resolution, string>> = {
      '1': '1m',
      '3': '1m',
      '5': '5m',
      '15': '15m',
      '30': '30m',
      '45': '15m',
      '60': '60m',
      '120': '60m',
      '240': '60m',
      '1D': '1d',
      '1W': '1wk',
      '1M': '1mo',
    };
    const interval = intervalMap[resolution] ?? '15m';
    const range =
      interval === '1d' || interval === '1wk' || interval === '1mo'
        ? '2y'
        : interval === '1m'
          ? '5d'
          : interval === '5m' || interval === '15m' || interval === '30m'
            ? '30d'
            : '60d';

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySym)}?interval=${interval}&range=${range}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) OpenView/0.3' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { bars: [] };
    const json = (await res.json()) as {
      chart?: {
        result?: Array<{
          meta?: {
            regularMarketPrice?: number;
            chartPreviousClose?: number;
            previousClose?: number;
            regularMarketTime?: number;
          };
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
    if (!q || ts.length === 0) return { bars: [] };

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

    const metaPrice = r0?.meta?.regularMarketPrice;
    const prevClose = r0?.meta?.previousClose ?? r0?.meta?.chartPreviousClose;
    return {
      bars: out,
      ...(metaPrice !== undefined ? { metaPrice } : {}),
      ...(prevClose !== undefined ? { prevClose } : {}),
    };
  } catch {
    return { bars: [] };
  }
}

export async function fetchYahooLatestQuote(symbol: SymbolInfo): Promise<QuoteTick | null> {
  try {
    const ySym = toYahooSymbol(symbol);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySym)}?interval=1m&range=1d`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) OpenView/0.3' },
      signal: AbortSignal.timeout(4500),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      chart?: {
        result?: Array<{
          meta?: {
            regularMarketPrice?: number;
            regularMarketVolume?: number;
            previousClose?: number;
            chartPreviousClose?: number;
            regularMarketTime?: number;
          };
        }>;
      };
    };
    const meta = json.chart?.result?.[0]?.meta;
    if (!meta || typeof meta.regularMarketPrice !== 'number') return null;

    const last = meta.regularMarketPrice;
    const prev = meta.previousClose ?? meta.chartPreviousClose ?? last;
    const change = last - prev;
    const changePct = prev !== 0 ? (change / prev) * 100 : 0;

    return {
      symbol: symbol.id,
      last,
      change,
      changePct,
      ...(symbol.hasVolume && typeof meta.regularMarketVolume === 'number'
        ? { volume: meta.regularMarketVolume }
        : {}),
      timestamp: (meta.regularMarketTime ?? Math.floor(Date.now() / 1000)) * 1000,
      feedQuality: symbol.calendarId === 'FOREX_OTC' ? 'live_quote_zero_vol' : 'delayed_eod',
    };
  } catch {
    return null;
  }
}

/**
 * Live Bar Aggregator: folds incoming real-time price/size ticks cleanly into the
 * active SessionCalendar-aligned forming OHLCV bar.
 */
export class FormingBarBuilder {
  private readonly symbol: SymbolInfo;
  private readonly resolution: Resolution;
  private current: OHLCVBar | null = null;

  constructor(symbol: SymbolInfo, resolution: Resolution, seedBar?: OHLCVBar) {
    this.symbol = symbol;
    this.resolution = resolution;
    if (seedBar) this.current = { ...seedBar };
  }

  ingestTick(price: number, size: number, timestampMs: number): OHLCVBar {
    const bucket = calendar.bucketBarTimestamp(
      timestampMs,
      this.resolution,
      this.symbol.calendarId,
    ).openTime;
    const vol = this.symbol.hasVolume && Number.isFinite(size) ? Math.max(0, size) : 0;

    if (!this.current || bucket > this.current.time) {
      this.current = {
        time: bucket,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: vol,
      };
    } else {
      this.current.high = Math.max(this.current.high, price);
      this.current.low = Math.min(this.current.low, price);
      this.current.close = price;
      this.current.volume += vol;
    }
    return { ...this.current };
  }
}

/**
 * BYOK Tiingo Live FX WebSocket (Forex & Gold XAUUSD/XAGUSD)
 */
export function subscribeTiingoFxWs(
  symbol: SymbolInfo,
  resolution: Resolution,
  apiKey: string,
  onBar: (bar: OHLCVBar, quality: FeedQualityBadge) => void,
  seedBar?: OHLCVBar,
): () => void {
  const ticker = symbol.ticker.toLowerCase();
  const builder = new FormingBarBuilder(symbol, resolution, seedBar);
  let closed = false;
  let ws: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    if (closed) return;
    ws = new WebSocket('wss://api.tiingo.com/fx');
    ws.on('open', () => {
      ws?.send(
        JSON.stringify({
          eventName: 'subscribe',
          authorization: apiKey,
          eventData: { thresholdLevel: 5, tickers: [ticker] },
        }),
      );
    });
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString('utf8')) as {
          messageType?: string;
          data?: [string, string, string, number, number, number, number, number];
        };
        if (msg.messageType === 'A' && Array.isArray(msg.data)) {
          // Tiingo FX quote array: ['Q', ticker, isoDate, bidSize, bidPrice, midPrice, askSize, askPrice]
          const ts = Date.parse(msg.data[2]) || Date.now();
          const mid = Number(msg.data[5]);
          if (Number.isFinite(mid) && mid > 0) {
            onBar(builder.ingestTick(mid, 0, ts), 'live_quote_zero_vol');
          }
        }
      } catch {
        // ignore malformed frame
      }
    });
    ws.on('close', () => {
      if (!closed) retry = setTimeout(connect, 3000);
    });
    ws.on('error', () => {
      ws?.close();
    });
  };

  connect();
  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    ws?.close();
  };
}

/**
 * BYOK Alpaca v2 Live WebSocket (US Stocks & ETFs: IEX or SIP)
 */
export function subscribeAlpacaLiveWs(
  symbol: SymbolInfo,
  resolution: Resolution,
  apiKey: string,
  apiSecret: string,
  feed: 'iex' | 'sip',
  onBar: (bar: OHLCVBar, quality: FeedQualityBadge) => void,
  seedBar?: OHLCVBar,
): () => void {
  const quality: FeedQualityBadge = feed === 'sip' ? 'live_full_vol' : 'live_subset_vol';
  const builder = new FormingBarBuilder(symbol, resolution, seedBar);
  let closed = false;
  let ws: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    if (closed) return;
    ws = new WebSocket(`wss://stream.data.alpaca.markets/v2/${feed}`);
    ws.on('open', () => {
      ws?.send(JSON.stringify({ action: 'auth', key: apiKey, secret: apiSecret }));
    });
    ws.on('message', (raw) => {
      try {
        const frames = JSON.parse(raw.toString('utf8')) as Array<Record<string, unknown>>;
        if (!Array.isArray(frames)) return;
        for (const f of frames) {
          if (f.T === 'success' && f.msg === 'authenticated') {
            ws?.send(JSON.stringify({ action: 'subscribe', trades: [symbol.ticker] }));
          } else if (f.T === 't' && f.S === symbol.ticker) {
            const px = Number(f.p);
            const sz = Number(f.s ?? 0);
            const ts = typeof f.t === 'string' ? Date.parse(f.t) : Date.now();
            if (Number.isFinite(px) && px > 0) {
              onBar(builder.ingestTick(px, sz, ts), quality);
            }
          }
        }
      } catch {
        // ignore
      }
    });
    ws.on('close', () => {
      if (!closed) retry = setTimeout(connect, 3000);
    });
    ws.on('error', () => {
      ws?.close();
    });
  };

  connect();
  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    ws?.close();
  };
}

/**
 * BYOK Finnhub Live WebSocket (US Stocks Real-Time Trades)
 */
export function subscribeFinnhubLiveWs(
  symbol: SymbolInfo,
  resolution: Resolution,
  apiKey: string,
  onBar: (bar: OHLCVBar, quality: FeedQualityBadge) => void,
  seedBar?: OHLCVBar,
): () => void {
  const builder = new FormingBarBuilder(symbol, resolution, seedBar);
  let closed = false;
  let ws: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    if (closed) return;
    ws = new WebSocket(`wss://ws.finnhub.io?token=${encodeURIComponent(apiKey)}`);
    ws.on('open', () => {
      ws?.send(JSON.stringify({ type: 'subscribe', symbol: symbol.ticker }));
    });
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString('utf8')) as {
          type?: string;
          data?: Array<{ p: number; v: number; t: number; s: string }>;
        };
        if (msg.type === 'trade' && Array.isArray(msg.data)) {
          for (const tr of msg.data) {
            if (tr.s === symbol.ticker && Number.isFinite(tr.p)) {
              onBar(builder.ingestTick(tr.p, tr.v ?? 0, tr.t), 'live_subset_vol');
            }
          }
        }
      } catch {
        // ignore
      }
    });
    ws.on('close', () => {
      if (!closed) retry = setTimeout(connect, 3000);
    });
    ws.on('error', () => {
      ws?.close();
    });
  };

  connect();
  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    ws?.close();
  };
}

/**
 * Live Polling Stream Helper for Upstox v3 / Fyers v3 / OANDA v20 / Zero-Key Yahoo Live Feed:
 * Polls latest real market price cleanly on an interval and emits SessionCalendar-aligned forming bars.
 */
export function subscribePolledLiveBar(
  symbol: SymbolInfo,
  resolution: Resolution,
  intervalMs: number,
  quality: FeedQualityBadge,
  fetcher: () => Promise<{ price: number; volume?: number; timestamp?: number } | null>,
  onBar: (bar: OHLCVBar, quality: FeedQualityBadge) => void,
  seedBar?: OHLCVBar,
): () => void {
  const builder = new FormingBarBuilder(symbol, resolution, seedBar);
  let stopped = false;
  let inFlight = false;

  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const sample = await fetcher();
      if (!stopped && sample && Number.isFinite(sample.price) && sample.price > 0) {
        onBar(
          builder.ingestTick(sample.price, sample.volume ?? 0, sample.timestamp ?? Date.now()),
          quality,
        );
      }
    } catch {
      // transient network error; retry on next interval
    } finally {
      inFlight = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
