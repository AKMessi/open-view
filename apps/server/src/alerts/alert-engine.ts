import crypto from 'node:crypto';
import type { OHLCVBar } from '@openview/protocol';
import { resolveAndValidateWebhookUrl } from '../security/ssrf.ts';

export type AlertRuleKind = 'price' | 'trendline' | 'indicator';
export type AlertOperator = 'crossing' | 'crossing_up' | 'crossing_down' | 'greater_than' | 'less_than';
export type AlertFrequency = 'only_once' | 'once_per_bar' | 'once_per_bar_close';

export interface AlertRule {
  id: string;
  name: string;
  symbol: string;
  resolution: string;
  kind: AlertRuleKind;
  operator: AlertOperator;
  frequency: AlertFrequency;
  enabled: boolean;
  /** Static threshold for kind === 'price' */
  targetPrice?: number;
  /** Two time-price anchors for kind === 'trendline' */
  lineAnchors?: [{ time: number; price: number }, { time: number; price: number }];
  /** Optional built-in indicator expression for kind === 'indicator' */
  indicatorExpr?: 'rsi14' | 'ema20_vs_50';
  indicatorThreshold?: number;
  webhookUrl?: string;
  webhookSecret?: string;
  webhookFormat?: 'generic' | 'discord' | 'telegram';
  telegramChatId?: string;
  message: string;
  createdAt: number;
  lastTriggeredBarTime?: number;
  triggerCount: number;
}

export interface AlertTriggerEvent {
  id: string;
  alertId: string;
  alertName: string;
  symbol: string;
  price: number;
  thresholdPrice: number;
  message: string;
  triggeredAt: number;
  webhookStatus?: 'skipped' | 'delivered' | 'blocked_ssrf' | 'failed';
  webhookError?: string;
}

export function interpolateTrendlinePriceAtTime(
  a0: { time: number; price: number },
  a1: { time: number; price: number },
  timeMs: number,
): number | null {
  const dt = a1.time - a0.time;
  if (Math.abs(dt) < 1) return a0.price;
  const t = (timeMs - a0.time) / dt;
  return a0.price + t * (a1.price - a0.price);
}

export function evaluateCrossingCondition(
  operator: AlertOperator,
  prevValue: number,
  currValue: number,
  prevThreshold: number,
  currThreshold: number,
): boolean {
  switch (operator) {
    case 'greater_than':
      return currValue > currThreshold;
    case 'less_than':
      return currValue < currThreshold;
    case 'crossing_up':
      return prevValue <= prevThreshold && currValue > currThreshold;
    case 'crossing_down':
      return prevValue >= prevThreshold && currValue < currThreshold;
    case 'crossing':
      return (
        (prevValue <= prevThreshold && currValue > currThreshold) ||
        (prevValue >= prevThreshold && currValue < currThreshold)
      );
  }
}

export function signWebhookPayload(payloadJson: string, secret: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(payloadJson, 'utf8').digest('hex')}`;
}

export interface WebhookDispatchResult {
  status: 'delivered' | 'blocked_ssrf' | 'failed';
  statusCode?: number;
  error?: string;
  signature?: string;
}

/**
 * SSRF-Guarded HMAC-SHA256 Webhook Dispatcher:
 * Resolves DNS and blocks loopback / RFC1918 / link-local / cloud metadata IPs BEFORE dispatch.
 */
export async function dispatchGuardedWebhook(
  rule: AlertRule,
  event: AlertTriggerEvent,
  options?: {
    lookupFn?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
    fetchFn?: typeof fetch;
  },
): Promise<WebhookDispatchResult> {
  if (!rule.webhookUrl) {
    return { status: 'failed', error: 'No webhook URL configured' };
  }

  let validated;
  try {
    validated = await resolveAndValidateWebhookUrl(rule.webhookUrl, options?.lookupFn);
  } catch (err) {
    return {
      status: 'blocked_ssrf',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  let bodyObj: Record<string, unknown>;
  if (rule.webhookFormat === 'discord') {
    bodyObj = {
      content: `**[OpenView Alert] ${event.alertName}** · \`${event.symbol}\` @ **${event.price}**\n${event.message}`,
    };
  } else if (rule.webhookFormat === 'telegram') {
    bodyObj = {
      chat_id: rule.telegramChatId ?? '',
      text: `[OpenView Alert] ${event.alertName} (${event.symbol} @ ${event.price}): ${event.message}`,
    };
  } else {
    bodyObj = {
      event: 'openview.alert.triggered',
      alertId: event.alertId,
      name: event.alertName,
      symbol: event.symbol,
      price: event.price,
      thresholdPrice: event.thresholdPrice,
      message: event.message,
      triggeredAt: event.triggeredAt,
    };
  }

  const payloadJson = JSON.stringify(bodyObj);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'OpenView-AlertEngine/0.2',
  };
  let signature: string | undefined;
  if (rule.webhookSecret) {
    signature = signWebhookPayload(payloadJson, rule.webhookSecret);
    headers['X-OpenView-Signature'] = signature;
  }

  try {
    const doFetch = options?.fetchFn ?? fetch;
    const res = await doFetch(validated.url.toString(), {
      method: 'POST',
      headers,
      body: payloadJson,
      redirect: 'error', // Prevent open-redirect SSRF bypass!
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return {
        status: 'failed',
        statusCode: res.status,
        error: `HTTP ${res.status}`,
        ...(signature ? { signature } : {}),
      };
    }
    return {
      status: 'delivered',
      statusCode: res.status,
      ...(signature ? { signature } : {}),
    };
  } catch (err) {
    return {
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
      ...(signature ? { signature } : {}),
    };
  }
}

/**
 * 24/7 Stateful Alerts Evaluator:
 * Evaluates Price, Sloped Trendline Crossing, and Indicator alerts across live bar ticks
 * with strict deduplication (`only_once`, `once_per_bar`, `once_per_bar_close`).
 */
export class AlertEngine {
  private readonly rules = new Map<string, AlertRule>();
  private readonly prevBarBySymbol = new Map<string, OHLCVBar>();
  private readonly recentEvents: AlertTriggerEvent[] = [];
  private readonly listeners = new Set<(ev: AlertTriggerEvent) => void>();

  onTrigger(fn: (ev: AlertTriggerEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  loadRules(rules: readonly AlertRule[]): void {
    this.rules.clear();
    for (const r of rules) this.rules.set(r.id, { ...r });
  }

  upsertRule(rule: AlertRule): AlertRule {
    this.rules.set(rule.id, { ...rule });
    return rule;
  }

  deleteRule(id: string): boolean {
    return this.rules.delete(id);
  }

  listRules(): AlertRule[] {
    return [...this.rules.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  listEvents(limit = 50): AlertTriggerEvent[] {
    return this.recentEvents.slice(0, limit);
  }

  async evaluateBar(
    symbol: string,
    bar: OHLCVBar,
    options?: {
      isBarClosed?: boolean;
      indicatorValues?: Record<string, { prev: number; curr: number }>;
      dispatchOptions?: Parameters<typeof dispatchGuardedWebhook>[2];
    },
  ): Promise<AlertTriggerEvent[]> {
    const key = symbol.toUpperCase();
    const prevBar = this.prevBarBySymbol.get(key) ?? bar;
    const isClosed = options?.isBarClosed ?? false;
    const fired: AlertTriggerEvent[] = [];

    for (const rule of this.rules.values()) {
      if (!rule.enabled || rule.symbol.toUpperCase() !== key) continue;
      if (rule.frequency === 'once_per_bar_close' && !isClosed) continue;
      if (rule.frequency === 'once_per_bar' && rule.lastTriggeredBarTime === bar.time) continue;

      let prevVal = prevBar.close;
      let currVal = bar.close;
      let prevThresh: number | null = null;
      let currThresh: number | null = null;

      if (rule.kind === 'price' && rule.targetPrice !== undefined) {
        prevThresh = rule.targetPrice;
        currThresh = rule.targetPrice;
      } else if (rule.kind === 'trendline' && rule.lineAnchors) {
        const [a0, a1] = rule.lineAnchors;
        prevThresh = interpolateTrendlinePriceAtTime(a0, a1, prevBar.time);
        currThresh = interpolateTrendlinePriceAtTime(a0, a1, bar.time);
      } else if (rule.kind === 'indicator' && rule.indicatorExpr && options?.indicatorValues?.[rule.indicatorExpr]) {
        const iv = options.indicatorValues[rule.indicatorExpr]!;
        prevVal = iv.prev;
        currVal = iv.curr;
        prevThresh = rule.indicatorThreshold ?? 50;
        currThresh = rule.indicatorThreshold ?? 50;
      }

      if (prevThresh === null || currThresh === null) continue;
      if (!evaluateCrossingCondition(rule.operator, prevVal, currVal, prevThresh, currThresh)) {
        continue;
      }

      rule.lastTriggeredBarTime = bar.time;
      rule.triggerCount += 1;
      if (rule.frequency === 'only_once') {
        rule.enabled = false;
      }

      const event: AlertTriggerEvent = {
        id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        alertId: rule.id,
        alertName: rule.name,
        symbol: rule.symbol,
        price: bar.close,
        thresholdPrice: Number(currThresh.toFixed(6)),
        message: rule.message || `${rule.symbol} ${rule.operator} ${currThresh.toFixed(2)}`,
        triggeredAt: Date.now(),
        ...(!rule.webhookUrl ? { webhookStatus: 'skipped' as const } : {}),
      };

      if (rule.webhookUrl) {
        const res = await dispatchGuardedWebhook(rule, event, options?.dispatchOptions);
        event.webhookStatus = res.status;
        if (res.error) event.webhookError = res.error;
      }

      this.recentEvents.unshift(event);
      if (this.recentEvents.length > 200) this.recentEvents.pop();
      fired.push(event);
      for (const fn of this.listeners) fn(event);
    }

    this.prevBarBySymbol.set(key, bar);
    return fired;
  }
}
