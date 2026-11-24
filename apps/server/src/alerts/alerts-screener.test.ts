import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { OHLCVBar } from '@openview/protocol';
import { createBridgeServer, type RunningBridgeServer } from '../app.ts';
import { computeScreenerFeaturesFromBars, filterAndSortScreenerRows } from '../screener/screener-service.ts';
import { PassphraseRamSealer } from '../security/vault.ts';
import {
  AlertEngine,
  dispatchGuardedWebhook,
  signWebhookPayload,
  type AlertRule,
} from './alert-engine.ts';

function makeBars(count = 80, start = 100): OHLCVBar[] {
  const out: OHLCVBar[] = [];
  let p = start;
  const t0 = Date.UTC(2026, 0, 5, 9, 15, 0);
  for (let i = 0; i < count; i++) {
    const open = p;
    const close = open + (i < 40 ? 0.8 : -0.5);
    out.push({
      time: t0 + i * 60_000,
      open,
      high: Math.max(open, close) + 0.6,
      low: Math.min(open, close) - 0.5,
      close,
      volume: 1000 + i * 25,
    });
    p = close;
  }
  return out;
}

describe('Phase 8 — 24/7 Alerts Engine, SSRF Webhook Defense & Multi-Market WASM Screener', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  it('fires Price & Sloped Trendline Crossing alerts with only_once and once_per_bar deduplication', async () => {
    const engine = new AlertEngine();
    const t0 = Date.UTC(2026, 0, 5, 9, 15, 0);

    // Rising trendline from (t0, 100) to (t0 + 10m, 110) -> slope +1 per minute
    const trendRule: AlertRule = {
      id: 'alrt_trend',
      name: 'Sloped Breakout',
      symbol: 'NSE:RELIANCE',
      resolution: '1',
      kind: 'trendline',
      operator: 'crossing_up',
      frequency: 'only_once',
      enabled: true,
      lineAnchors: [
        { time: t0, price: 100 },
        { time: t0 + 10 * 60_000, price: 110 },
      ],
      message: 'Broke above rising resistance',
      createdAt: t0,
      triggerCount: 0,
    };
    engine.upsertRule(trendRule);

    // At t0 + 4m, line price = 104. Bar closes at 103 -> below line (no trigger)
    const ev1 = await engine.evaluateBar('NSE:RELIANCE', {
      time: t0 + 4 * 60_000,
      open: 102,
      high: 103.5,
      low: 101.5,
      close: 103,
      volume: 500,
    });
    expect(ev1).toHaveLength(0);

    // At t0 + 5m, line price = 105. Bar closes at 106 -> crosses UP!
    const ev2 = await engine.evaluateBar('NSE:RELIANCE', {
      time: t0 + 5 * 60_000,
      open: 103,
      high: 106.5,
      low: 103,
      close: 106,
      volume: 800,
    });
    expect(ev2).toHaveLength(1);
    expect(ev2[0]!.thresholdPrice).toBeCloseTo(105, 4);

    // only_once disables rule immediately -> no duplicate fires
    const ev3 = await engine.evaluateBar('NSE:RELIANCE', {
      time: t0 + 6 * 60_000,
      open: 106,
      high: 108,
      low: 106,
      close: 108,
      volume: 900,
    });
    expect(ev3).toHaveLength(0);
    expect(engine.listRules()[0]!.enabled).toBe(false);
  });

  it('blocks SSRF internal/metadata webhooks BEFORE network dispatch and signs valid webhooks with HMAC-SHA256', async () => {
    let fetchCalled = false;
    const mockFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      fetchCalled = true;
      const body = String(init?.body ?? '');
      const sig = (init?.headers as Record<string, string>)['X-OpenView-Signature'];
      expect(sig).toBe(signWebhookPayload(body, 'top-secret-key'));
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    const baseEvent = {
      id: 'evt_1',
      alertId: 'a1',
      alertName: 'Gold Break',
      symbol: 'FX:XAUUSD',
      price: 2700,
      thresholdPrice: 2695,
      message: 'Gold crossed 2695',
      triggeredAt: Date.now(),
    };

    // 1. Metadata SSRF attack MUST be blocked before fetch is called
    const ssrfRes = await dispatchGuardedWebhook(
      {
        id: 'a1',
        name: 'SSRF',
        symbol: 'FX:XAUUSD',
        resolution: '15',
        kind: 'price',
        operator: 'crossing_up',
        frequency: 'only_once',
        enabled: true,
        targetPrice: 2695,
        webhookUrl: 'http://169.254.169.254/latest/meta-data/',
        message: 'x',
        createdAt: Date.now(),
        triggerCount: 1,
      },
      baseEvent,
      { fetchFn: mockFetch },
    );
    expect(ssrfRes.status).toBe('blocked_ssrf');
    expect(fetchCalled).toBe(false);

    // 2. Public IP with HMAC-SHA256 signature succeeds cleanly
    const pubRes = await dispatchGuardedWebhook(
      {
        id: 'a2',
        name: 'Gold Break',
        symbol: 'FX:XAUUSD',
        resolution: '15',
        kind: 'price',
        operator: 'crossing_up',
        frequency: 'only_once',
        enabled: true,
        targetPrice: 2695,
        webhookUrl: 'https://hooks.example.com/openview',
        webhookSecret: 'top-secret-key',
        message: 'Gold crossed 2695',
        createdAt: Date.now(),
        triggerCount: 1,
      },
      baseEvent,
      {
        lookupFn: async () => [{ address: '93.184.216.34', family: 4 }],
        fetchFn: mockFetch,
      },
    );
    expect(pubRes.status).toBe('delivered');
    expect(fetchCalled).toBe(true);
    expect(pubRes.signature?.startsWith('sha256=')).toBe(true);
  });

  it('computes Rust/WASM Screener technical features and exposes authenticated Alerts + Execution Airlock APIs on Bridge', async () => {
    const feats = computeScreenerFeaturesFromBars(makeBars(80, 100));
    expect(feats.rsi14).toBeGreaterThan(0);
    expect(feats.rsi14).toBeLessThan(100);
    expect(feats.atrPct).toBeGreaterThan(0);
    expect(feats.bbWidthPct).toBeGreaterThan(0);

    const sorted = filterAndSortScreenerRows(
      [
        {
          symbol: 'BINANCE:BTCUSDT',
          ticker: 'BTCUSDT',
          description: 'Bitcoin',
          exchange: 'BINANCE',
          market: 'crypto',
          currency: 'USDT',
          ...feats,
          changePct: 4.5,
          rsi14: 68,
          feedQuality: 'live_full_vol',
          updatedAt: Date.now(),
        },
        {
          symbol: 'NSE:RELIANCE',
          ticker: 'RELIANCE',
          description: 'Reliance',
          exchange: 'NSE',
          market: 'india_nse',
          currency: 'INR',
          ...feats,
          changePct: -1.2,
          rsi14: 32,
          feedQuality: 'delayed_eod',
          updatedAt: Date.now(),
        },
      ],
      { market: 'india_nse', maxRsi: 40 },
    );
    expect(sorted).toHaveLength(1);
    expect(sorted[0]!.symbol).toBe('NSE:RELIANCE');

    // Live Bridge HTTP integration check for Alerts + Execution Airlock endpoints
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openview-p8-'));
    const bridge: RunningBridgeServer = await createBridgeServer({
      port: 0,
      dbPath: path.join(tmpDir, 'p8.sqlite'),
      vaultKeyPath: path.join(tmpDir, 'vault.bin'),
      sealer: new PassphraseRamSealer('phase8-vault-pass', Buffer.from('salt-p8')),
    });
    cleanups.push(async () => {
      await bridge.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const sessRes = await fetch(`${bridge.url}/api/v1/auth/session`, { method: 'POST' });
    const { token } = (await sessRes.json()) as { token: string };

    // Create + list alert persisted in SQLite WAL worker
    const createRes = await fetch(`${bridge.url}/api/v1/alerts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-openview-token': token },
      body: JSON.stringify({
        name: 'BTC 100k',
        symbol: 'BINANCE:BTCUSDT',
        operator: 'crossing_up',
        targetPrice: 100_000,
        frequency: 'only_once',
        message: 'BTC crossed 100k',
      }),
    });
    expect(createRes.status).toBe(200);

    const listRes = await fetch(`${bridge.url}/api/v1/alerts`, {
      headers: { 'x-openview-token': token },
    });
    const listData = (await listRes.json()) as { alerts: AlertRule[] };
    expect(listData.alerts).toHaveLength(1);
    expect(listData.alerts[0]!.targetPrice).toBe(100_000);

    // Verify Execution Airlock defaults to PAPER over HTTP
    const execRes = await fetch(`${bridge.url}/api/v1/execution/status`, {
      headers: { 'x-openview-token': token },
    });
    const execData = (await execRes.json()) as { mode: string };
    expect(execData.mode).toBe('paper');
  });
});
