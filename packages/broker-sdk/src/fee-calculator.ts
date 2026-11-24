import type { SymbolInfo } from '@openview/protocol';

export type FeeProfileId =
  | 'crypto_spot'
  | 'crypto_perps'
  | 'forex_spot'
  | 'us_equities'
  | 'nse_equity_intraday'
  | 'nse_equity_delivery'
  | 'nse_futures'
  | 'nse_options';

export interface FeeBreakdown {
  profile: FeeProfileId;
  brokerage: number;
  stt: number;
  exchangeTxn: number;
  sebiFee: number;
  stampDuty: number;
  gst: number;
  dpCharge: number;
  total: number;
}

export function inferFeeProfile(symbol: SymbolInfo): FeeProfileId {
  if (symbol.market === 'crypto') {
    return symbol.segment === 'perps' ? 'crypto_perps' : 'crypto_spot';
  }
  if (symbol.market === 'forex' || symbol.market === 'commodities') {
    return 'forex_spot';
  }
  if (symbol.market === 'us_equity') {
    return 'us_equities';
  }
  if (symbol.segment === 'options') return 'nse_options';
  if (symbol.segment === 'futures') return 'nse_futures';
  return 'nse_equity_intraday';
}

/**
 * Computes realistic 2025-2026 market charges across Crypto, FX, US Equities, and Indian NSE/MCX
 * (including STT 0.02% Futures / 0.1% Options sell, True-to-Label NSE txn fees, Stamp Duty, SEBI, 18% GST).
 */
export function calculateTradeFees(
  profile: FeeProfileId,
  side: 'buy' | 'sell',
  price: number,
  quantity: number,
  isMaker = false,
): FeeBreakdown {
  const turnover = Math.abs(price * quantity);
  let brokerage = 0;
  let stt = 0;
  let exchangeTxn = 0;
  let sebiFee = 0;
  let stampDuty = 0;
  let gst = 0;
  let dpCharge = 0;

  switch (profile) {
    case 'crypto_spot':
      brokerage = turnover * ((isMaker ? 10 : 10) / 10_000);
      break;
    case 'crypto_perps':
      brokerage = turnover * ((isMaker ? 2 : 5) / 10_000);
      break;
    case 'forex_spot':
      // $3.50 per standard 100k lot
      brokerage = (Math.abs(quantity) / 100_000) * 3.5;
      break;
    case 'us_equities':
      brokerage = 0;
      if (side === 'sell') {
        sebiFee = turnover * 0.0000278; // SEC fee
        exchangeTxn = Math.min(8.3, Math.abs(quantity) * 0.000166); // FINRA TAF
      }
      break;
    case 'nse_equity_intraday':
      brokerage = Math.min(20, turnover * 0.0003);
      stt = side === 'sell' ? turnover * 0.00025 : 0;
      exchangeTxn = turnover * 0.0000297;
      sebiFee = turnover * 0.000001;
      stampDuty = side === 'buy' ? turnover * 0.00003 : 0;
      gst = (brokerage + exchangeTxn + sebiFee) * 0.18;
      break;
    case 'nse_equity_delivery':
      brokerage = 0;
      stt = turnover * 0.001;
      exchangeTxn = turnover * 0.0000297;
      sebiFee = turnover * 0.000001;
      stampDuty = side === 'buy' ? turnover * 0.00015 : 0;
      gst = (brokerage + exchangeTxn + sebiFee) * 0.18;
      dpCharge = side === 'sell' ? 15.93 : 0;
      break;
    case 'nse_futures':
      brokerage = 20;
      stt = side === 'sell' ? turnover * 0.0002 : 0;
      exchangeTxn = turnover * 0.0000173;
      sebiFee = turnover * 0.000001;
      stampDuty = side === 'buy' ? turnover * 0.00002 : 0;
      gst = (brokerage + exchangeTxn + sebiFee) * 0.18;
      break;
    case 'nse_options':
      brokerage = 20;
      stt = side === 'sell' ? turnover * 0.001 : 0;
      exchangeTxn = turnover * 0.0003503;
      sebiFee = turnover * 0.000001;
      stampDuty = side === 'buy' ? turnover * 0.00003 : 0;
      gst = (brokerage + exchangeTxn + sebiFee) * 0.18;
      break;
  }

  const total = brokerage + stt + exchangeTxn + sebiFee + stampDuty + gst + dpCharge;
  return { profile, brokerage, stt, exchangeTxn, sebiFee, stampDuty, gst, dpCharge, total };
}
