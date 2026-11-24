import { describe, expect, it } from 'vitest';
import type { SymbolInfo } from '@openview/protocol';
import {
  blackScholesGreeks,
  buildOptionChain,
  calculateTradeFees,
  PaperBrokerEngine,
} from './index.ts';

const NSE_FUT: SymbolInfo = {
  id: 'NSE:NIFTY1!',
  ticker: 'NIFTY1!',
  description: 'NIFTY Futures',
  exchange: 'NSE F&O',
  provider: 'upstox',
  market: 'futures',
  segment: 'futures',
  currency: 'INR',
  timezone: 'Asia/Kolkata',
  calendarId: 'NSE',
  tickSize: 0.1,
  precision: 1,
  lotSize: 75,
  hasVolume: true,
  supportsOrderbook: true,
  supportsTicks: true,
  feedQuality: 'live_full_vol',
};

describe('@openview/broker-sdk — Phase 5 Paper Trading, NSE Fees & Black-Scholes', () => {
  it('calculates 2025-2026 Indian NSE Futures & Options STT, Stamp Duty, SEBI & 18% GST accurately', () => {
    // Sell 1 lot NIFTY Futures (75 qty @ 24,000 = 18,00,000 turnover)
    // STT = 0.02% sell = ₹360, Brokerage = ₹20, Exchange = ₹31.14, SEBI = ₹1.80, GST = 18%*(20+31.14+1.80)
    const futSell = calculateTradeFees('nse_futures', 'sell', 24_000, 75);
    expect(futSell.brokerage).toBe(20);
    expect(futSell.stt).toBeCloseTo(360, 4);
    expect(futSell.stampDuty).toBe(0);
    expect(futSell.gst).toBeCloseTo((20 + futSell.exchangeTxn + futSell.sebiFee) * 0.18, 4);

    // Sell Options: 0.1% STT on premium turnover
    const optSell = calculateTradeFees('nse_options', 'sell', 200, 75);
    expect(optSell.stt).toBeCloseTo(15, 4);
    expect(optSell.brokerage).toBe(20);
  });

  it('enforces realistic Gap-Open Fill Rule on stop-loss gaps (never fills at impossible stop price)', () => {
    const broker = new PaperBrokerEngine(1_000_000, 1);
    broker.placeOrder({
      symbolInfo: NSE_FUT,
      side: 'buy',
      type: 'market',
      quantity: 75,
      stopLoss: 24_000,
      takeProfit: 24_500,
      currentBar: { time: 1000, open: 24_200, high: 24_210, low: 24_190, close: 24_200, volume: 1000 },
    });

    const snapOpen = broker.getSnapshot();
    expect(snapOpen.positions).toHaveLength(1);
    expect(snapOpen.workingOrders).toHaveLength(2); // SL + TP OCO children

    // Next morning NSE opens with a massive -500pt gap down at 23,700 (300 pts below SL 24,000!)
    broker.onBarUpdate('NSE:NIFTY1!', {
      time: 2000,
      open: 23_700,
      high: 23_750,
      low: 23_680,
      close: 23_720,
      volume: 5000,
    });

    const snapAfter = broker.getSnapshot();
    expect(snapAfter.positions).toHaveLength(0);
    // OCO must cancel sibling TP automatically!
    expect(snapAfter.workingOrders).toHaveLength(0);
    // Stop-loss fill MUST be at bar.open - 1 tick slippage (23,699.9), NOT 24,000!
    expect(snapAfter.fills[0]!.fillPrice).toBeCloseTo(23_699.9, 2);
    expect(snapAfter.realizedPnl).toBeLessThan(-35_000);
  });

  it('satisfies Black-Scholes Put-Call Parity and enforces SEBI weekly vs monthly expiry rules', () => {
    const S = 24_500;
    const K = 24_500;
    const T = 30 / 365;
    const r = 0.068;
    const sigma = 0.15;
    const call = blackScholesGreeks('call', S, K, T, r, sigma);
    const put = blackScholesGreeks('put', S, K, T, r, sigma);

    // Put-Call Parity: C - P = S - K * exp(-rT)
    const rhs = S - K * Math.exp(-r * T);
    expect(call.price - put.price).toBeCloseTo(rhs, 4);
    expect(call.delta - put.delta).toBeCloseTo(1.0, 6);

    const niftyChain = buildOptionChain(NSE_FUT, 24_510, 5);
    expect(niftyChain.expiryCycle).toBe('weekly');

    const bankNiftyChain = buildOptionChain({ ...NSE_FUT, id: 'NSE:BANKNIFTY', ticker: 'BANKNIFTY' }, 52_100, 5);
    expect(bankNiftyChain.expiryCycle).toBe('monthly');
  });
});
