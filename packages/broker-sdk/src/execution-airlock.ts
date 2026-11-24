import type { SymbolInfo } from '@openview/protocol';
import type { OrderSide, OrderType } from './paper-broker.ts';

export type ExecutionMode = 'paper' | 'live';

export interface LiveRiskLimits {
  maxOrderNotional: number;
  maxOrderQty: number;
  dailyLossLimit: number;
  /** Default Market Price Protection percentage for NSE/MCX (e.g., 0.5% -> ±0.5%) */
  nseMppPercent: number;
}

export interface SebiComplianceState {
  staticIpVerified: boolean;
  staticIpAddress?: string;
  /** Epoch ms of last verified daily broker 2FA login */
  last2faVerifiedAt?: number;
}

export interface LiveOrderRequest {
  brokerId: 'alpaca' | 'binance' | 'hyperliquid' | 'oanda' | 'upstox' | 'fyers' | 'dhan' | 'kite';
  symbolInfo: SymbolInfo;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  refPrice: number;
  limitPrice?: number;
  nowMs?: number;
}

export interface AirlockValidationResult {
  allowed: boolean;
  code?:
    | 'AIRLOCK_IN_PAPER_MODE'
    | 'QTY_LIMIT_EXCEEDED'
    | 'NOTIONAL_LIMIT_EXCEEDED'
    | 'DAILY_LOSS_LOCKED'
    | 'SEBI_STATIC_IP_REQUIRED'
    | 'SEBI_2FA_EXPIRED'
    | 'SEBI_RATE_LIMIT_EXCEEDED';
  reason?: string;
  preparedOrder?: {
    brokerId: LiveOrderRequest['brokerId'];
    symbol: string;
    side: OrderSide;
    effectiveType: OrderType;
    quantity: number;
    effectiveLimitPrice?: number;
    mppConverted: boolean;
    notional: number;
  };
}

const INDIAN_BROKERS = new Set<LiveOrderRequest['brokerId']>(['upstox', 'fyers', 'dhan', 'kite']);
export const LIVE_ARM_CONFIRMATION_PHRASE = 'ENABLE LIVE EXECUTION';
/** Hard client cap below SEBI April 2026 10 orders/sec retail algo threshold */
export const SEBI_MAX_ORDERS_PER_SECOND = 8;

function isPrivateOrInvalidIpv4(ip: string | undefined): boolean {
  if (!ip) return true;
  const rawParts = ip.trim().split('.');
  if (rawParts.length !== 4 || rawParts.some((p) => !/^\d{1,3}$/.test(p))) return true;
  const parts = rawParts.map(Number);
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isSameIstCalendarDay(tsA: number, tsB: number): boolean {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(tsA) === fmt.format(tsB);
}

function roundToTick(price: number, tickSize: number): number {
  const tick = tickSize > 0 ? tickSize : 0.05;
  return Number((Math.round(price / tick) * tick).toFixed(6));
}

/**
 * Execution Airlock & SEBI April 2026 Indian Retail Algo Compliance Guard:
 * - Always defaults to PAPER mode.
 * - Requires explicit confirmation phrase + risk limits to arm LIVE mode.
 * - Enforces Indian NSE/MCX SEBI Static IPv4 pre-flight check, daily IST 2FA validity,
 *   automatic Market Price Protection (MPP) limit conversion, and strict 8 orders/sec rate limiting.
 */
export class ExecutionAirlock {
  private mode: ExecutionMode = 'paper';
  private riskLimits: LiveRiskLimits = {
    maxOrderNotional: 100_000,
    maxOrderQty: 500,
    dailyLossLimit: 5_000,
    nseMppPercent: 0.5,
  };
  private sebi: SebiComplianceState = {
    staticIpVerified: false,
  };
  private dailyRealizedLoss = 0;
  private readonly indiaOrderTimestamps: number[] = [];

  getMode(): ExecutionMode {
    return this.mode;
  }

  getRiskLimits(): LiveRiskLimits {
    return { ...this.riskLimits };
  }

  getSebiCompliance(): SebiComplianceState {
    return { ...this.sebi };
  }

  updateSebiCompliance(state: SebiComplianceState): void {
    this.sebi = { ...state };
  }

  recordDailyLoss(lossAmountPositive: number): void {
    if (lossAmountPositive > 0) this.dailyRealizedLoss += lossAmountPositive;
  }

  armLiveMode(
    confirmationPhrase: string,
    limits?: Partial<LiveRiskLimits>,
  ): { armed: boolean; reason?: string } {
    if (confirmationPhrase.trim() !== LIVE_ARM_CONFIRMATION_PHRASE) {
      return {
        armed: false,
        reason: `Exact phrase "${LIVE_ARM_CONFIRMATION_PHRASE}" is required to arm live execution.`,
      };
    }
    if (limits) {
      this.riskLimits = { ...this.riskLimits, ...limits };
    }
    this.mode = 'live';
    return { armed: true };
  }

  disarmToPaper(): void {
    this.mode = 'paper';
  }

  validateAndPrepareLiveOrder(req: LiveOrderRequest): AirlockValidationResult {
    const now = req.nowMs ?? Date.now();
    if (this.mode !== 'live') {
      return {
        allowed: false,
        code: 'AIRLOCK_IN_PAPER_MODE',
        reason: 'Execution Airlock is in PAPER mode. Arm LIVE mode explicitly before routing broker orders.',
      };
    }

    if (this.dailyRealizedLoss >= this.riskLimits.dailyLossLimit) {
      return {
        allowed: false,
        code: 'DAILY_LOSS_LOCKED',
        reason: `Daily loss limit (${this.riskLimits.dailyLossLimit}) reached.`,
      };
    }

    if (req.quantity <= 0 || req.quantity > this.riskLimits.maxOrderQty) {
      return {
        allowed: false,
        code: 'QTY_LIMIT_EXCEEDED',
        reason: `Order quantity ${req.quantity} exceeds cap ${this.riskLimits.maxOrderQty}.`,
      };
    }

    const priceForNotional = req.limitPrice ?? req.refPrice;
    const notional = Math.abs(req.quantity * priceForNotional);
    if (notional > this.riskLimits.maxOrderNotional) {
      return {
        allowed: false,
        code: 'NOTIONAL_LIMIT_EXCEEDED',
        reason: `Order notional ${notional.toFixed(2)} exceeds cap ${this.riskLimits.maxOrderNotional}.`,
      };
    }

    const isIndiaOrder =
      INDIAN_BROKERS.has(req.brokerId) ||
      req.symbolInfo.calendarId === 'NSE' ||
      req.symbolInfo.calendarId === 'MCX';

    let effectiveType: OrderType = req.type;
    let effectiveLimitPrice = req.limitPrice;
    let mppConverted = false;

    if (isIndiaOrder) {
      // 1. Pre-flight Static IPv4 verification
      if (!this.sebi.staticIpVerified || isPrivateOrInvalidIpv4(this.sebi.staticIpAddress)) {
        return {
          allowed: false,
          code: 'SEBI_STATIC_IP_REQUIRED',
          reason:
            'SEBI April 2026 Compliance: A verified public Static IPv4 whitelisted with your Indian broker is required before live NSE/MCX order routing.',
        };
      }

      // 2. Mandatory Daily 2FA IST Session check
      if (!this.sebi.last2faVerifiedAt || !isSameIstCalendarDay(this.sebi.last2faVerifiedAt, now)) {
        return {
          allowed: false,
          code: 'SEBI_2FA_EXPIRED',
          reason:
            'SEBI Compliance: Daily Indian broker 2FA session is missing or expired for the current IST trading day.',
        };
      }

      // 3. Hard 8 orders/sec sliding-window rate limiter (below 10 OPS SEBI retail threshold)
      while (this.indiaOrderTimestamps.length > 0 && now - this.indiaOrderTimestamps[0]! >= 1000) {
        this.indiaOrderTimestamps.shift();
      }
      if (this.indiaOrderTimestamps.length >= SEBI_MAX_ORDERS_PER_SECOND) {
        return {
          allowed: false,
          code: 'SEBI_RATE_LIMIT_EXCEEDED',
          reason: `SEBI Retail Algo Guard: Hard client rate limit (${SEBI_MAX_ORDERS_PER_SECOND} orders/sec) exceeded.`,
        };
      }
      this.indiaOrderTimestamps.push(now);

      // 4. Automatic Market Price Protection (MPP) limit conversion
      if (req.type === 'market') {
        const mppFactor = Math.max(0.05, this.riskLimits.nseMppPercent) / 100;
        const protectedPx =
          req.side === 'buy'
            ? req.refPrice * (1 + mppFactor)
            : Math.max(req.symbolInfo.tickSize, req.refPrice * (1 - mppFactor));
        effectiveType = 'limit';
        effectiveLimitPrice = roundToTick(protectedPx, req.symbolInfo.tickSize);
        mppConverted = true;
      }
    }

    return {
      allowed: true,
      preparedOrder: {
        brokerId: req.brokerId,
        symbol: req.symbolInfo.id,
        side: req.side,
        effectiveType,
        quantity: req.quantity,
        ...(effectiveLimitPrice !== undefined ? { effectiveLimitPrice } : {}),
        mppConverted,
        notional,
      },
    };
  }
}
