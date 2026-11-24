import { generateSyntheticBars } from '@openview/chart-engine';
import {
  BinanceDirectDatafeed,
  findSymbolById,
  registerDynamicSymbol,
  searchCatalog,
} from '@openview/datafeed-sdk';
import type {
  FeedQualityBadge,
  MarketCategory,
  OHLCVBar,
  QuoteTick,
  Resolution,
  SymbolInfo,
  WorkspaceSnapshot,
  WsServerMessage,
} from '@openview/protocol';

const configuredBridgePort = (import.meta as { env?: Record<string, string | undefined> }).env
  ?.VITE_BRIDGE_PORT;
const isSelfHostedSameOrigin =
  typeof window !== 'undefined' &&
  !configuredBridgePort &&
  window.location.origin.startsWith('http') &&
  window.location.port !== '5173' &&
  window.location.port !== '4173';
const BRIDGE_HTTP = isSelfHostedSameOrigin
  ? window.location.origin
  : `http://127.0.0.1:${configuredBridgePort ?? '4001'}`;
const BRIDGE_WS = BRIDGE_HTTP.replace(/^http/, 'ws') + '/ws';

export interface ProviderStatusInfo {
  id: string;
  name: string;
  markets: string[];
  costTier: string;
  regionNote?: string;
  fields: Array<{ key: string; label: string; secret: boolean; placeholder?: string }>;
  configured: boolean;
  updatedAt: number | null;
}

export interface BridgeConnectionState {
  mode: 'connecting' | 'local_bridge' | 'static_mode';
  vaultMode?: string;
  wsRttMs?: number;
}

export interface AlertRuleClient {
  id: string;
  name: string;
  symbol: string;
  resolution: string;
  kind: 'price' | 'trendline' | 'indicator';
  operator: 'crossing' | 'crossing_up' | 'crossing_down' | 'greater_than' | 'less_than';
  frequency: 'only_once' | 'once_per_bar' | 'once_per_bar_close';
  enabled: boolean;
  targetPrice?: number;
  webhookUrl?: string;
  webhookFormat?: 'generic' | 'discord' | 'telegram';
  message: string;
  createdAt: number;
  triggerCount: number;
}

export interface AlertTriggerEventClient {
  id: string;
  alertId: string;
  alertName: string;
  symbol: string;
  price: number;
  thresholdPrice: number;
  message: string;
  triggeredAt: number;
}

export interface ScreenerRowClient {
  symbol: string;
  ticker: string;
  description: string;
  exchange: string;
  market: string;
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

export interface ChartSubscriptionHandlers {
  onSnapshot: (info: SymbolInfo, bars: OHLCVBar[], noMoreHistory: boolean, providerLabel: string) => void;
  onBarUpdate: (bar: OHLCVBar, quality: FeedQualityBadge) => void;
  onHistoryResult?: (bars: OHLCVBar[], noMoreHistory: boolean) => void;
}

/**
 * Unified Frontend Market Client:
 * - Connects to secured local Node 24 Bridge (Session -> Single-Use WS Ticket) when available.
 * - Seamlessly falls back to Zero-Backend Static Mode (direct public Crypto WS + synthetic/local files)
 *   when the Bridge server is offline.
 */
export class MarketClient {
  private token: string | null = null;
  private ws: WebSocket | null = null;
  private state: BridgeConnectionState = { mode: 'connecting' };
  private readonly cryptoDirect = new BinanceDirectDatafeed();

  private readonly stateListeners = new Set<(s: BridgeConnectionState) => void>();
  private readonly chartHandlers = new Map<string, ChartSubscriptionHandlers>();
  private readonly chartSubSeq = new Map<string, number>();
  private readonly activeChartSpecs = new Map<string, { symbolId: string; resolution: Resolution }>();
  private readonly directChartUnsubs = new Map<string, () => void>();
  private readonly quoteListeners = new Set<(q: QuoteTick) => void>();
  private readonly alertListeners = new Set<(ev: AlertTriggerEventClient) => void>();
  private directQuoteUnsub: (() => void) | null = null;
  private activeQuoteSymbols: string[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = 2500;
  private connectingBridge = false;
  private disposed = false;

  get connectionState(): BridgeConnectionState {
    return this.state;
  }

  onConnectionChange(fn: (s: BridgeConnectionState) => void): () => void {
    this.stateListeners.add(fn);
    fn(this.state);
    return () => this.stateListeners.delete(fn);
  }

  private setState(next: BridgeConnectionState): void {
    this.state = next;
    for (const fn of this.stateListeners) fn(next);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleBridgeReconnect(): void {
    if (this.disposed || this.reconnectTimer !== null || this.state.mode === 'local_bridge') return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.disposed || this.state.mode === 'local_bridge') return;
      void this.tryConnectBridgeOnce().then((connected) => {
        if (connected) {
          this.reconnectDelayMs = 2500;
        } else {
          this.reconnectDelayMs = Math.min(8000, Math.round(this.reconnectDelayMs * 1.4));
          this.scheduleBridgeReconnect();
        }
      });
    }, this.reconnectDelayMs);
  }

  private async tryConnectBridgeOnce(): Promise<boolean> {
    if (this.disposed || this.connectingBridge) return false;
    this.connectingBridge = true;
    try {
      const healthRes = await fetch(`${BRIDGE_HTTP}/api/health`, {
        credentials: 'include',
        signal: AbortSignal.timeout(2200),
      });
      if (!healthRes.ok) throw new Error('unhealthy');
      const health = (await healthRes.json()) as { vaultMode: string };

      const sessRes = await fetch(`${BRIDGE_HTTP}/api/v1/auth/session`, {
        method: 'POST',
        credentials: 'include',
        signal: AbortSignal.timeout(2200),
      });
      if (!sessRes.ok) throw new Error('session failed');
      const { token } = (await sessRes.json()) as { token: string };
      this.token = token;

      const ticketRes = await fetch(`${BRIDGE_HTTP}/api/v1/auth/ws-ticket`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'x-openview-token': token },
        signal: AbortSignal.timeout(2200),
      });
      if (!ticketRes.ok) throw new Error('ticket failed');
      const { ticket } = (await ticketRes.json()) as { ticket: string };

      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(`${BRIDGE_WS}?ticket=${encodeURIComponent(ticket)}`);
        let settled = false;
        const failTimer = setTimeout(() => {
          if (!settled) {
            settled = true;
            socket.close();
            reject(new Error('WS handshake timeout'));
          }
        }, 3000);

        socket.onopen = () => {
          socket.send(JSON.stringify({ type: 'ping', id: 1, ts: performance.now() }));
        };

        socket.onmessage = (ev) => {
          const msg = JSON.parse(String(ev.data)) as WsServerMessage;
          if (msg.type === 'pong' && !settled) {
            settled = true;
            clearTimeout(failTimer);
            // Tear down any static-mode fallback streams before switching to Bridge WS
            for (const unsub of this.directChartUnsubs.values()) unsub();
            this.directChartUnsubs.clear();
            this.directQuoteUnsub?.();
            this.directQuoteUnsub = null;

            this.ws = socket;
            this.clearReconnectTimer();
            this.setState({
              mode: 'local_bridge',
              vaultMode: health.vaultMode,
              wsRttMs: Math.max(0.1, Number((performance.now() - msg.clientTs).toFixed(1))),
            });
            resolve();
            return;
          }
          this.dispatchWsMessage(msg);
        };

        socket.onerror = () => {
          if (!settled) {
            settled = true;
            clearTimeout(failTimer);
            reject(new Error('WS failed'));
          }
        };
        socket.onclose = () => {
          if (!settled) {
            settled = true;
            clearTimeout(failTimer);
            reject(new Error('WS closed before pong'));
            return;
          }
          if (this.ws === socket) {
            this.ws = null;
            this.token = null;
            if (!this.disposed && this.state.mode === 'local_bridge') {
              this.setState({ mode: 'static_mode' });
              this.reconnectDelayMs = 2000;
              this.scheduleBridgeReconnect();
            }
          }
        };
      });

      return true;
    } catch {
      return false;
    } finally {
      this.connectingBridge = false;
    }
  }

  async connect(): Promise<BridgeConnectionState> {
    // Allow up to ~3s across 4 rapid attempts on cold boot (Windows DPAPI vault unseal takes ~1-2s!)
    const retryDelays = [0, 500, 900, 1200];
    for (const delay of retryDelays) {
      if (this.disposed) return this.state;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      if (await this.tryConnectBridgeOnce()) {
        return this.state;
      }
    }
    this.ws = null;
    this.token = null;
    this.setState({ mode: 'static_mode' });
    this.scheduleBridgeReconnect();
    return this.state;
  }

  async reconnectNow(): Promise<BridgeConnectionState> {
    this.clearReconnectTimer();
    this.reconnectDelayMs = 2500;
    if (await this.tryConnectBridgeOnce()) {
      return this.state;
    }
    if (this.state.mode !== 'local_bridge') {
      this.scheduleBridgeReconnect();
    }
    return this.state;
  }

  private dispatchWsMessage(msg: WsServerMessage): void {
    switch (msg.type) {
      case 'chart.snapshot': {
        const h = this.chartHandlers.get(msg.sessionId);
        h?.onSnapshot(msg.symbolInfo, msg.bars, msg.noMoreHistory, msg.symbolInfo.provider);
        break;
      }
      case 'chart.bar_update': {
        const h = this.chartHandlers.get(msg.sessionId);
        h?.onBarUpdate(msg.bar, msg.feedQuality);
        break;
      }
      case 'chart.history_result': {
        const h = this.chartHandlers.get(msg.sessionId);
        h?.onHistoryResult?.(msg.bars, msg.noMoreHistory);
        break;
      }
      case 'quote.update': {
        for (const fn of this.quoteListeners) fn(msg.quote);
        break;
      }
      case 'alert.triggered': {
        const ev: AlertTriggerEventClient = {
          id: `${msg.alertId}-${msg.triggeredAt}`,
          alertId: msg.alertId,
          alertName: msg.alertName,
          symbol: msg.symbol,
          price: msg.price,
          thresholdPrice: msg.thresholdPrice,
          message: msg.message,
          triggeredAt: msg.triggeredAt,
        };
        for (const fn of this.alertListeners) fn(ev);
        break;
      }
    }
  }

  subscribeChart(
    sessionId: string,
    symbolId: string,
    resolution: Resolution,
    handlers: ChartSubscriptionHandlers,
  ): () => void {
    this.unsubscribeChart(sessionId);
    const seq = (this.chartSubSeq.get(sessionId) ?? 0) + 1;
    this.chartSubSeq.set(sessionId, seq);
    this.chartHandlers.set(sessionId, handlers);
    this.activeChartSpecs.set(sessionId, { symbolId, resolution });

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: 'chart.subscribe',
          sessionId,
          symbol: symbolId,
          resolution,
        }),
      );
      return () => {
        if (this.chartSubSeq.get(sessionId) === seq) {
          this.unsubscribeChart(sessionId);
        }
      };
    }

    // Static Mode fallback: direct public Crypto WS, or honest fallback for Bridge-only markets
    const sym = findSymbolById(symbolId);
    if (!sym) return () => this.unsubscribeChart(sessionId);

    if (
      sym.market === 'crypto' ||
      sym.id.startsWith('BINANCE:') ||
      sym.id.startsWith('HYPERLIQUID:')
    ) {
      void this.cryptoDirect
        .getBars({ symbol: sym, resolution, countBack: 500 })
        .then((res) => {
          // CRITICAL: Guard against async race when user switched symbol/TF before getBars resolved!
          if (this.chartSubSeq.get(sessionId) !== seq) return;
          if (res.bars.length > 0) {
            handlers.onSnapshot({ ...sym, feedQuality: res.feedQuality }, res.bars, false, res.providerLabel);
          } else {
            const fallback = generateSyntheticBars(sym, resolution, 400);
            handlers.onSnapshot({ ...sym, feedQuality: 'delayed_eod' }, fallback, true, 'Static Offline Demo');
          }
          // Ensure any prior direct socket is closed before opening a new one
          this.directChartUnsubs.get(sessionId)?.();
          const unsub = this.cryptoDirect.subscribeBars(sym, resolution, (bar, q) => {
            if (this.chartSubSeq.get(sessionId) !== seq) return;
            handlers.onBarUpdate(bar, q);
          });
          if (this.chartSubSeq.get(sessionId) !== seq) {
            unsub();
            return;
          }
          this.directChartUnsubs.set(sessionId, unsub);
        });
    } else {
      const demo = generateSyntheticBars(sym, resolution, 400, sym.id.length * 19);
      queueMicrotask(() => {
        if (this.chartSubSeq.get(sessionId) !== seq) return;
        handlers.onSnapshot(
          { ...sym, feedQuality: 'delayed_eod' },
          demo,
          true,
          'Static Mode (Start Bridge for Live)',
        );
      });
    }

    return () => {
      if (this.chartSubSeq.get(sessionId) === seq) {
        this.unsubscribeChart(sessionId);
      }
    };
  }

  requestMoreHistory(sessionId: string, beforeTime: number, count = 400): void {
    const seq = this.chartSubSeq.get(sessionId);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: 'chart.history',
          requestId: `${sessionId}-${Date.now()}`,
          sessionId,
          beforeTime,
          count,
        }),
      );
      return;
    }

    // Static Mode direct Crypto left-scroll history pagination
    const spec = this.activeChartSpecs.get(sessionId);
    const handler = this.chartHandlers.get(sessionId);
    if (!spec || !handler) return;
    const sym = findSymbolById(spec.symbolId);
    if (
      sym &&
      (sym.market === 'crypto' || sym.id.startsWith('BINANCE:') || sym.id.startsWith('HYPERLIQUID:'))
    ) {
      void this.cryptoDirect
        .getBars({ symbol: sym, resolution: spec.resolution, countBack: count, to: beforeTime - 1 })
        .then((res) => {
          if (this.chartSubSeq.get(sessionId) !== seq) return;
          handler.onHistoryResult?.(res.bars, res.bars.length < 10);
        })
        .catch(() => {
          if (this.chartSubSeq.get(sessionId) !== seq) return;
          handler.onHistoryResult?.([], true);
        });
    } else {
      handler.onHistoryResult?.([], true);
    }
  }

  unsubscribeChart(sessionId: string): void {
    this.chartSubSeq.set(sessionId, (this.chartSubSeq.get(sessionId) ?? 0) + 1);
    this.chartHandlers.delete(sessionId);
    this.activeChartSpecs.delete(sessionId);
    this.directChartUnsubs.get(sessionId)?.();
    this.directChartUnsubs.delete(sessionId);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'chart.unsubscribe', sessionId }));
    }
  }

  subscribeQuotes(symbols: string[], onQuote: (q: QuoteTick) => void): () => void {
    this.quoteListeners.add(onQuote);
    this.activeQuoteSymbols = symbols;

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'quote.subscribe', symbols }));
    } else {
      this.directQuoteUnsub?.();
      this.directQuoteUnsub = this.cryptoDirect.subscribeQuotes(symbols, (q) => {
        for (const fn of this.quoteListeners) fn(q);
      });
    }

    return () => {
      this.quoteListeners.delete(onQuote);
      if (this.quoteListeners.size === 0) {
        this.directQuoteUnsub?.();
        this.directQuoteUnsub = null;
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'quote.unsubscribe', symbols: this.activeQuoteSymbols }));
        }
      }
    };
  }

  async searchSymbols(
    query: string,
    market: MarketCategory | 'all' = 'all',
    limit = 60,
  ): Promise<{
    symbols: SymbolInfo[];
    totalCached?: number;
    source: 'bridge_universal' | 'local_catalog';
  }> {
    if (this.state.mode === 'local_bridge') {
      try {
        const qs = new URLSearchParams({ q: query, market, limit: String(limit) });
        const res = await fetch(`${BRIDGE_HTTP}/api/v1/symbols/search?${qs.toString()}`, {
          credentials: 'include',
          signal: AbortSignal.timeout(4000),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            symbols: SymbolInfo[];
            stats?: { totalCached: number };
          };
          for (const sym of data.symbols) registerDynamicSymbol(sym);
          return {
            symbols: data.symbols,
            ...(data.stats ? { totalCached: data.stats.totalCached } : {}),
            source: 'bridge_universal',
          };
        }
      } catch {
        // fallback to local catalog
      }
    }
    return {
      symbols: searchCatalog(query, market, limit),
      source: 'local_catalog',
    };
  }

  async listProviders(): Promise<ProviderStatusInfo[]> {
    if (!this.token) return [];
    const res = await fetch(`${BRIDGE_HTTP}/api/v1/vault/providers`, {
      credentials: 'include',
      headers: { 'x-openview-token': this.token },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { providers: ProviderStatusInfo[] };
    return data.providers;
  }

  async saveProviderCredentials(providerId: string, payload: Record<string, string>): Promise<boolean> {
    if (!this.token) return false;
    const res = await fetch(`${BRIDGE_HTTP}/api/v1/vault/providers/${encodeURIComponent(providerId)}`, {
      method: 'PUT',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'x-openview-token': this.token,
      },
      body: JSON.stringify(payload),
    });
    return res.ok;
  }

  async deleteProviderCredentials(providerId: string): Promise<boolean> {
    if (!this.token) return false;
    const res = await fetch(`${BRIDGE_HTTP}/api/v1/vault/providers/${encodeURIComponent(providerId)}`, {
      method: 'DELETE',
      credentials: 'include',
      headers: { 'x-openview-token': this.token },
    });
    return res.ok;
  }

  async syncWorkspaceToBridge(snapshot: WorkspaceSnapshot): Promise<void> {
    if (!this.token) return;
    await fetch(`${BRIDGE_HTTP}/api/v1/workspaces/${encodeURIComponent(snapshot.id)}`, {
      method: 'PUT',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'x-openview-token': this.token,
      },
      body: JSON.stringify(snapshot),
    }).catch(() => {});
  }

  async fetchHistory(
    symbolId: string,
    resolution: Resolution,
    count = 400,
  ): Promise<{ symbolInfo: SymbolInfo; bars: OHLCVBar[] } | null> {
    if (this.token) {
      try {
        const qs = new URLSearchParams({ symbol: symbolId, resolution, count: String(count) });
        const res = await fetch(`${BRIDGE_HTTP}/api/v1/history?${qs.toString()}`, {
          credentials: 'include',
          headers: { 'x-openview-token': this.token },
        });
        if (res.ok) {
          const data = (await res.json()) as { symbolInfo: SymbolInfo; bars: OHLCVBar[] };
          if (data.bars.length > 0) return data;
        }
      } catch {
        // Fall through to direct / synthetic fallback
      }
    }

    const sym = findSymbolById(symbolId);
    if (!sym) return null;
    if (
      sym.market === 'crypto' ||
      sym.id.startsWith('BINANCE:') ||
      sym.id.startsWith('HYPERLIQUID:')
    ) {
      try {
        const res = await this.cryptoDirect.getBars({ symbol: sym, resolution, countBack: count });
        if (res.bars.length > 0) return { symbolInfo: sym, bars: res.bars };
      } catch {
        // fallback below
      }
    }
    return { symbolInfo: sym, bars: generateSyntheticBars(sym, resolution, count, sym.id.length * 19) };
  }

  onAlertTriggered(fn: (ev: AlertTriggerEventClient) => void): () => void {
    this.alertListeners.add(fn);
    return () => this.alertListeners.delete(fn);
  }

  async listAlerts(): Promise<AlertRuleClient[]> {
    if (!this.token) return [];
    const res = await fetch(`${BRIDGE_HTTP}/api/v1/alerts`, {
      credentials: 'include',
      headers: { 'x-openview-token': this.token },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { alerts: AlertRuleClient[] };
    return data.alerts;
  }

  async createAlert(payload: Omit<AlertRuleClient, 'id' | 'enabled' | 'createdAt' | 'triggerCount'>): Promise<boolean> {
    if (!this.token) return false;
    const res = await fetch(`${BRIDGE_HTTP}/api/v1/alerts`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'x-openview-token': this.token },
      body: JSON.stringify(payload),
    });
    return res.ok;
  }

  async deleteAlert(id: string): Promise<boolean> {
    if (!this.token) return false;
    const res = await fetch(`${BRIDGE_HTTP}/api/v1/alerts/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      credentials: 'include',
      headers: { 'x-openview-token': this.token },
    });
    return res.ok;
  }

  async listAlertEvents(): Promise<AlertTriggerEventClient[]> {
    if (!this.token) return [];
    const res = await fetch(`${BRIDGE_HTTP}/api/v1/alerts/events`, {
      credentials: 'include',
      headers: { 'x-openview-token': this.token },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { events: AlertTriggerEventClient[] };
    return data.events;
  }

  async queryScreener(params: {
    market?: string;
    minRsi?: number;
    maxRsi?: number;
    emaSignal?: string;
    supertrend?: string;
    sortBy?: string;
    sortDir?: string;
    refresh?: boolean;
  }): Promise<{ rows: ScreenerRowClient[]; scannedCount: number; elapsedMs: number; cached: boolean }> {
    if (this.token) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== '') qs.set(k, String(v));
      }
      const res = await fetch(`${BRIDGE_HTTP}/api/v1/screener?${qs.toString()}`, {
        credentials: 'include',
        headers: { 'x-openview-token': this.token },
      });
      if (res.ok) {
        return (await res.json()) as {
          rows: ScreenerRowClient[];
          scannedCount: number;
          elapsedMs: number;
          cached: boolean;
        };
      }
    }
    return { rows: [], scannedCount: 0, elapsedMs: 0, cached: false };
  }

  dispose(): void {
    this.disposed = true;
    this.clearReconnectTimer();
    for (const id of [...this.chartHandlers.keys()]) this.unsubscribeChart(id);
    this.directQuoteUnsub?.();
    this.directQuoteUnsub = null;
    this.ws?.close();
    this.ws = null;
  }
}
