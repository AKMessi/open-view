import { describe, expect, it } from 'vitest';
import type { SymbolInfo } from '@openview/protocol';
import {
  ExecutionAirlock,
  LIVE_ARM_CONFIRMATION_PHRASE,
  SEBI_MAX_ORDERS_PER_SECOND,
} from './execution-airlock.ts';

const NSE_RELIANCE: SymbolInfo = {
  id: 'NSE:RELIANCE',
  ticker: 'RELIANCE',
  description: 'Reliance Industries Ltd',
  exchange: 'NSE',
  provider: 'upstox',
  market: 'india_nse',
  segment: 'equity',
  currency: 'INR',
  timezone: 'Asia/Kolkata',
  calendarId: 'NSE',
  tickSize: 0.1,
  precision: 2,
  lotSize: 1,
  hasVolume: true,
  supportsOrderbook: true,
  supportsTicks: true,
  feedQuality: 'live_full_vol',
};

describe('Phase 8 — Execution Airlock & SEBI April 2026 Indian Retail Algo Safeguards', () => {
  it('defaults strictly to PAPER mode and requires exact confirmation phrase to arm LIVE', () => {
    const airlock = new ExecutionAirlock();
    expect(airlock.getMode()).toBe('paper');

    const blocked = airlock.validateAndPrepareLiveOrder({
      brokerId: 'upstox',
      symbolInfo: NSE_RELIANCE,
      side: 'buy',
      type: 'market',
      quantity: 10,
      refPrice: 1340,
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.code).toBe('AIRLOCK_IN_PAPER_MODE');

    expect(airlock.armLiveMode('wrong phrase').armed).toBe(false);
    expect(airlock.armLiveMode(LIVE_ARM_CONFIRMATION_PHRASE, { maxOrderNotional: 500_000 }).armed).toBe(true);
    expect(airlock.getMode()).toBe('live');
  });

  it('enforces SEBI Static IPv4 pre-flight, IST daily 2FA, MPP limit conversion & 8 orders/sec cap', () => {
    const airlock = new ExecutionAirlock();
    airlock.armLiveMode(LIVE_ARM_CONFIRMATION_PHRASE, {
      maxOrderNotional: 1_000_000,
      maxOrderQty: 1000,
      nseMppPercent: 0.5,
    });

    const now = Date.UTC(2026, 3, 15, 5, 0, 0); // 10:30 AM IST

    // 1. Blocked without Static IPv4
    const noIp = airlock.validateAndPrepareLiveOrder({
      brokerId: 'upstox',
      symbolInfo: NSE_RELIANCE,
      side: 'buy',
      type: 'market',
      quantity: 10,
      refPrice: 1340,
      nowMs: now,
    });
    expect(noIp.allowed).toBe(false);
    expect(noIp.code).toBe('SEBI_STATIC_IP_REQUIRED');

    // Private IPv4 must also be rejected!
    airlock.updateSebiCompliance({
      staticIpVerified: true,
      staticIpAddress: '192.168.1.50',
      last2faVerifiedAt: now,
    });
    expect(
      airlock.validateAndPrepareLiveOrder({
        brokerId: 'upstox',
        symbolInfo: NSE_RELIANCE,
        side: 'buy',
        type: 'market',
        quantity: 10,
        refPrice: 1340,
        nowMs: now,
      }).code,
    ).toBe('SEBI_STATIC_IP_REQUIRED');

    // 2. Expired 2FA (yesterday IST) must be blocked
    airlock.updateSebiCompliance({
      staticIpVerified: true,
      staticIpAddress: '49.205.112.14',
      last2faVerifiedAt: now - 24 * 3600_000,
    });
    expect(
      airlock.validateAndPrepareLiveOrder({
        brokerId: 'fyers',
        symbolInfo: NSE_RELIANCE,
        side: 'buy',
        type: 'market',
        quantity: 10,
        refPrice: 1340,
        nowMs: now,
      }).code,
    ).toBe('SEBI_2FA_EXPIRED');

    // 3. Valid public Static IPv4 + today's IST 2FA -> converts naked market order to MPP limit!
    airlock.updateSebiCompliance({
      staticIpVerified: true,
      staticIpAddress: '49.205.112.14',
      last2faVerifiedAt: now - 60_000,
    });
    const ok = airlock.validateAndPrepareLiveOrder({
      brokerId: 'upstox',
      symbolInfo: NSE_RELIANCE,
      side: 'buy',
      type: 'market',
      quantity: 10,
      refPrice: 1340,
      nowMs: now,
    });
    expect(ok.allowed).toBe(true);
    expect(ok.preparedOrder?.mppConverted).toBe(true);
    expect(ok.preparedOrder?.effectiveType).toBe('limit');
    // 1340 * 1.005 = 1346.70 (exact multiple of tickSize 0.10)
    expect(ok.preparedOrder?.effectiveLimitPrice).toBeCloseTo(1346.7, 4);

    // 4. Hard 8 orders/sec rate limiter: orders 2..8 pass, order 9 within 1000ms is REJECTED!
    for (let i = 1; i < SEBI_MAX_ORDERS_PER_SECOND; i++) {
      const r = airlock.validateAndPrepareLiveOrder({
        brokerId: 'upstox',
        symbolInfo: NSE_RELIANCE,
        side: 'buy',
        type: 'limit',
        quantity: 1,
        refPrice: 1340,
        limitPrice: 1339,
        nowMs: now + i * 50,
      });
      expect(r.allowed).toBe(true);
    }

    const ninth = airlock.validateAndPrepareLiveOrder({
      brokerId: 'upstox',
      symbolInfo: NSE_RELIANCE,
      side: 'buy',
      type: 'limit',
      quantity: 1,
      refPrice: 1340,
      limitPrice: 1339,
      nowMs: now + 500,
    });
    expect(ninth.allowed).toBe(false);
    expect(ninth.code).toBe('SEBI_RATE_LIMIT_EXCEEDED');
  });
});
