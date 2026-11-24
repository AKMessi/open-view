import type { SymbolInfo } from '@openview/protocol';

export interface OptionGreeks {
  price: number;
  delta: number;
  gamma: number;
  thetaDaily: number;
  vegaPerPct: number;
}

export interface OptionStrikeRow {
  strike: number;
  call: OptionGreeks & { iv: number; oi: number; oiChg: number; volume: number };
  put: OptionGreeks & { iv: number; oi: number; oiChg: number; volume: number };
  isAtm: boolean;
}

export interface OptionChainSnapshot {
  underlying: string;
  spotPrice: number;
  expiryLabel: string;
  expiryCycle: 'weekly' | 'monthly';
  sebiRuleNote?: string;
  rows: OptionStrikeRow[];
}

/**
 * Standard normal CDF via Abramowitz-Stegun polynomial approximation (error < 7.5e-8).
 */
function normCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * ax);
  const poly =
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t);
  const erf = 1 - poly * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * erf);
}

function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Exact Black-Scholes European Option Pricing & Analytical Greeks.
 */
export function blackScholesGreeks(
  type: 'call' | 'put',
  spot: number,
  strike: number,
  timeYears: number,
  riskFreeRate: number,
  sigma: number,
): OptionGreeks {
  const T = Math.max(1e-6, timeYears);
  const v = Math.max(1e-4, sigma);
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(spot / strike) + (riskFreeRate + 0.5 * v * v) * T) / (v * sqrtT);
  const d2 = d1 - v * sqrtT;

  const pdfD1 = normPdf(d1);
  const discK = strike * Math.exp(-riskFreeRate * T);

  const gamma = pdfD1 / (spot * v * sqrtT);
  const vegaPerPct = (spot * pdfD1 * sqrtT) / 100;

  if (type === 'call') {
    const price = spot * normCdf(d1) - discK * normCdf(d2);
    const delta = normCdf(d1);
    const thetaAnnual = -(spot * pdfD1 * v) / (2 * sqrtT) - riskFreeRate * discK * normCdf(d2);
    return { price: Math.max(0.05, price), delta, gamma, thetaDaily: thetaAnnual / 365, vegaPerPct };
  }

  const price = discK * normCdf(-d2) - spot * normCdf(-d1);
  const delta = normCdf(d1) - 1;
  const thetaAnnual = -(spot * pdfD1 * v) / (2 * sqrtT) + riskFreeRate * discK * normCdf(-d2);
  return { price: Math.max(0.05, price), delta, gamma, thetaDaily: thetaAnnual / 365, vegaPerPct };
}

/**
 * Builds an analytical Option Chain around spotPrice with exact SEBI 2025-2026 expiry rules
 * (Weekly expiries strictly on benchmark NIFTY/SENSEX; Monthly on BANKNIFTY & NSE stocks).
 */
export function buildOptionChain(
  symbol: SymbolInfo,
  spotPrice: number,
  daysToExpiry = 7,
  baseIv = 0.145,
): OptionChainSnapshot {
  const isNiftyWeekly = symbol.ticker === 'NIFTY' || symbol.ticker === 'NIFTY1!';
  const isBankNifty = symbol.ticker === 'BANKNIFTY' || symbol.ticker === 'BANKNIFTY1!';
  const isIndian = symbol.calendarId === 'NSE' || symbol.calendarId === 'MCX';

  const expiryCycle: 'weekly' | 'monthly' =
    isIndian && !isNiftyWeekly ? 'monthly' : daysToExpiry <= 10 ? 'weekly' : 'monthly';
  const effectiveDte = isIndian && !isNiftyWeekly ? Math.max(daysToExpiry, 18) : daysToExpiry;
  const riskFree = isIndian ? 0.068 : 0.045;

  const strikeStep = isBankNifty
    ? 100
    : isNiftyWeekly
      ? 50
      : spotPrice > 5000
        ? 100
        : spotPrice > 1000
          ? 20
          : spotPrice > 200
            ? 5
            : 1;

  const atmStrike = Math.round(spotPrice / strikeStep) * strikeStep;
  const rows: OptionStrikeRow[] = [];
  const T = effectiveDte / 365;

  for (let offset = -7; offset <= 7; offset++) {
    const strike = atmStrike + offset * strikeStep;
    if (strike <= 0) continue;
    // Realistic volatility smile skew (OTM puts slightly higher IV)
    const moneyness = (strike - spotPrice) / spotPrice;
    const callIv = Math.max(0.06, baseIv + Math.abs(moneyness) * 0.35 - moneyness * 0.12);
    const putIv = Math.max(0.06, baseIv + Math.abs(moneyness) * 0.42 - moneyness * 0.25);

    const c = blackScholesGreeks('call', spotPrice, strike, T, riskFree, callIv);
    const p = blackScholesGreeks('put', spotPrice, strike, T, riskFree, putIv);
    const decay = Math.exp(-Math.abs(offset) * 0.28);

    rows.push({
      strike,
      isAtm: offset === 0,
      call: {
        ...c,
        iv: callIv * 100,
        oi: Math.round(450_000 * decay * (offset >= 0 ? 1.35 : 0.65)),
        oiChg: Math.round(38_000 * decay * (offset >= 0 ? 1 : -0.4)),
        volume: Math.round(180_000 * decay),
      },
      put: {
        ...p,
        iv: putIv * 100,
        oi: Math.round(480_000 * decay * (offset <= 0 ? 1.4 : 0.6)),
        oiChg: Math.round(42_000 * decay * (offset <= 0 ? 1 : -0.35)),
        volume: Math.round(170_000 * decay),
      },
    });
  }

  const expiryDate = new Date(Date.now() + effectiveDte * 86_400_000).toISOString().slice(0, 10);
  return {
    underlying: symbol.id,
    spotPrice,
    expiryLabel: `${expiryDate} (${effectiveDte} DTE · ${expiryCycle.toUpperCase()})`,
    expiryCycle,
    ...(isIndian
      ? {
          sebiRuleNote: isNiftyWeekly
            ? 'SEBI Benchmark Weekly Expiry (NIFTY)'
            : 'SEBI Rule: Monthly Expiry Only (Non-Benchmark NSE Derivative)',
        }
      : {}),
    rows,
  };
}
