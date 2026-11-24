import type {
  FeedQualityBadge,
  OHLCVBar,
  OrderbookDelta,
  QuoteTick,
  Resolution,
  SymbolInfo,
  TradeTick,
} from './market.ts';

export type WsClientMessage =
  | { type: 'ping'; id: number; ts: number }
  | {
      type: 'chart.subscribe';
      sessionId: string;
      symbol: string;
      resolution: Resolution;
      extendedHours?: boolean;
    }
  | { type: 'chart.unsubscribe'; sessionId: string }
  | {
      type: 'chart.history';
      requestId: string;
      sessionId: string;
      beforeTime: number;
      count: number;
    }
  | { type: 'quote.subscribe'; symbols: string[] }
  | { type: 'quote.unsubscribe'; symbols: string[] }
  | { type: 'trades.subscribe'; symbol: string }
  | { type: 'trades.unsubscribe'; symbol: string }
  | { type: 'depth.subscribe'; symbol: string; levels: number }
  | { type: 'depth.unsubscribe'; symbol: string };

export type WsServerMessage =
  | { type: 'pong'; id: number; clientTs: number; serverTs: number }
  | {
      type: 'hello';
      serverVersion: string;
      bridgeMode: 'local' | 'self_hosted';
      serverTs: number;
    }
  | {
      type: 'chart.snapshot';
      sessionId: string;
      symbolInfo: SymbolInfo;
      resolution: Resolution;
      bars: OHLCVBar[];
      noMoreHistory: boolean;
    }
  | {
      type: 'chart.history_result';
      requestId: string;
      sessionId: string;
      bars: OHLCVBar[];
      noMoreHistory: boolean;
    }
  | {
      type: 'chart.bar_update';
      sessionId: string;
      bar: OHLCVBar;
      feedQuality: FeedQualityBadge;
    }
  | { type: 'quote.update'; quote: QuoteTick }
  | { type: 'trades.tick'; trade: TradeTick }
  | { type: 'depth.delta'; delta: OrderbookDelta }
  | {
      type: 'provider.status';
      provider: string;
      status: 'connected' | 'reconnecting' | 'degraded' | 'offline' | 'auth_expired';
      message?: string;
    }
  | {
      type: 'alert.triggered';
      alertId: string;
      alertName: string;
      symbol: string;
      price: number;
      thresholdPrice: number;
      message: string;
      triggeredAt: number;
    }
  | { type: 'error'; code: string; message: string; sessionId?: string };

export function parseWsClientMessage(raw: string): WsClientMessage | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || !('type' in parsed)) {
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    switch (obj.type) {
      case 'ping':
        if (typeof obj.id === 'number' && typeof obj.ts === 'number') {
          return { type: 'ping', id: obj.id, ts: obj.ts };
        }
        return null;
      case 'chart.subscribe':
        if (
          typeof obj.sessionId === 'string' &&
          typeof obj.symbol === 'string' &&
          typeof obj.resolution === 'string'
        ) {
          return {
            type: 'chart.subscribe',
            sessionId: obj.sessionId,
            symbol: obj.symbol,
            resolution: obj.resolution as Resolution,
            ...(typeof obj.extendedHours === 'boolean'
              ? { extendedHours: obj.extendedHours }
              : {}),
          };
        }
        return null;
      case 'chart.unsubscribe':
        if (typeof obj.sessionId === 'string') {
          return { type: 'chart.unsubscribe', sessionId: obj.sessionId };
        }
        return null;
      case 'chart.history':
        if (
          typeof obj.requestId === 'string' &&
          typeof obj.sessionId === 'string' &&
          typeof obj.beforeTime === 'number' &&
          typeof obj.count === 'number'
        ) {
          return {
            type: 'chart.history',
            requestId: obj.requestId,
            sessionId: obj.sessionId,
            beforeTime: obj.beforeTime,
            count: obj.count,
          };
        }
        return null;
      case 'quote.subscribe':
      case 'quote.unsubscribe':
        if (Array.isArray(obj.symbols) && obj.symbols.every((s) => typeof s === 'string')) {
          return { type: obj.type, symbols: obj.symbols };
        }
        return null;
      case 'trades.subscribe':
      case 'trades.unsubscribe':
        if (typeof obj.symbol === 'string') {
          return { type: obj.type, symbol: obj.symbol };
        }
        return null;
      case 'depth.subscribe':
        if (typeof obj.symbol === 'string' && typeof obj.levels === 'number') {
          return { type: 'depth.subscribe', symbol: obj.symbol, levels: obj.levels };
        }
        return null;
      case 'depth.unsubscribe':
        if (typeof obj.symbol === 'string') {
          return { type: 'depth.unsubscribe', symbol: obj.symbol };
        }
        return null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}
