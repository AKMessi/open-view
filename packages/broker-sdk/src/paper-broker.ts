import type { OHLCVBar, SymbolInfo } from '@openview/protocol';
import { calculateTradeFees, inferFeeProfile, type FeeProfileId } from './fee-calculator.ts';

export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit' | 'stop';
export type OrderStatus = 'working' | 'filled' | 'cancelled';

export interface PaperOrder {
  id: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  price?: number;
  stopLoss?: number;
  takeProfit?: number;
  parentOrderId?: string;
  role?: 'entry' | 'sl' | 'tp';
  status: OrderStatus;
  createdAt: number;
  filledAt?: number;
  fillPrice?: number;
  feePaid?: number;
}

export interface PaperPosition {
  symbol: string;
  side: 'long' | 'short';
  quantity: number;
  avgEntryPrice: number;
  lastPrice: number;
  unrealizedPnl: number;
  feeProfile: FeeProfileId;
}

export interface PaperFillRecord {
  id: string;
  orderId: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  fillPrice: number;
  feeTotal: number;
  realizedPnl: number;
  timestamp: number;
}

export interface PaperAccountSnapshot {
  startingCapital: number;
  cash: number;
  equity: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalFeesPaid: number;
  positions: PaperPosition[];
  workingOrders: PaperOrder[];
  fills: PaperFillRecord[];
}

export interface PlaceOrderInput {
  symbolInfo: SymbolInfo;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  price?: number;
  stopLoss?: number;
  takeProfit?: number;
  currentBar?: OHLCVBar;
}

/**
 * Deterministic Paper Trading Matching Engine (identical behavior in Live & Bar Replay modes).
 * Enforces realistic Gap-Open Slippage Fill Rules:
 * - If a candle gaps past a Stop-Loss or Stop order, it fills at `bar.open ± slippage` (NEVER at the impossible trigger price!).
 */
export class PaperBrokerEngine {
  private readonly startingCapital: number;
  private cash: number;
  private realizedPnl = 0;
  private totalFeesPaid = 0;
  private slippageTicks: number;

  private readonly orders = new Map<string, PaperOrder>();
  private readonly positions = new Map<string, PaperPosition>();
  private readonly symbolMeta = new Map<string, SymbolInfo>();
  private readonly fills: PaperFillRecord[] = [];
  private listeners = new Set<(snap: PaperAccountSnapshot) => void>();
  private seq = 1;

  constructor(startingCapital = 100_000, slippageTicks = 1) {
    this.startingCapital = startingCapital;
    this.cash = startingCapital;
    this.slippageTicks = slippageTicks;
  }

  onChange(fn: (snap: PaperAccountSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    const snap = this.getSnapshot();
    for (const fn of this.listeners) fn(snap);
  }

  reset(): void {
    this.cash = this.startingCapital;
    this.realizedPnl = 0;
    this.totalFeesPaid = 0;
    this.orders.clear();
    this.positions.clear();
    this.fills.length = 0;
    this.emit();
  }

  placeOrder(input: PlaceOrderInput): PaperOrder {
    const { symbolInfo, side, type, quantity, price, stopLoss, takeProfit, currentBar } = input;
    if (quantity <= 0 || !Number.isFinite(quantity)) {
      throw new Error('Order quantity must be positive');
    }
    this.symbolMeta.set(symbolInfo.id, symbolInfo);
    const id = `ord_${this.seq++}`;
    const order: PaperOrder = {
      id,
      symbol: symbolInfo.id,
      side,
      type,
      quantity,
      role: 'entry',
      status: 'working',
      createdAt: currentBar?.time ?? Date.now(),
      ...(price !== undefined ? { price } : {}),
      ...(stopLoss !== undefined ? { stopLoss } : {}),
      ...(takeProfit !== undefined ? { takeProfit } : {}),
    };
    this.orders.set(id, order);

    if (type === 'market') {
      const refPrice = currentBar?.close ?? price;
      if (refPrice === undefined || !Number.isFinite(refPrice)) {
        throw new Error('Market order requires currentBar or reference price');
      }
      const slip = symbolInfo.tickSize * this.slippageTicks;
      const fillPrice = side === 'buy' ? refPrice + slip : Math.max(symbolInfo.tickSize, refPrice - slip);
      this.executeFill(order, fillPrice, currentBar?.time ?? Date.now(), false);
    } else {
      this.emit();
    }

    return order;
  }

  modifyOrder(orderId: string, newPrice: number): boolean {
    const ord = this.orders.get(orderId);
    if (!ord || ord.status !== 'working' || !Number.isFinite(newPrice)) return false;
    ord.price = newPrice;
    this.emit();
    return true;
  }

  cancelOrder(orderId: string): boolean {
    const ord = this.orders.get(orderId);
    if (!ord || ord.status !== 'working') return false;
    ord.status = 'cancelled';
    this.emit();
    return true;
  }

  closePosition(symbolId: string, currentBar: OHLCVBar): boolean {
    const pos = this.positions.get(symbolId);
    const sym = this.symbolMeta.get(symbolId);
    if (!pos || !sym) return false;
    // Cancel resting bracket orders for this symbol
    for (const o of this.orders.values()) {
      if (o.symbol === symbolId && o.status === 'working' && (o.role === 'sl' || o.role === 'tp')) {
        o.status = 'cancelled';
      }
    }
    this.placeOrder({
      symbolInfo: sym,
      side: pos.side === 'long' ? 'sell' : 'buy',
      type: 'market',
      quantity: pos.quantity,
      currentBar,
    });
    return true;
  }

  /**
   * Process an incoming Live or Replay bar/tick:
   * Evaluates all working orders using Gap-Open Fill Realism and updates live unrealized P&L.
   */
  onBarUpdate(symbolId: string, bar: OHLCVBar): void {
    const sym = this.symbolMeta.get(symbolId);
    const tick = sym?.tickSize ?? 0.01;
    const slip = tick * this.slippageTicks;

    // Evaluate working orders (SL checked conservatively before TP if same bar hits both)
    const working = [...this.orders.values()]
      .filter((o) => o.symbol === symbolId && o.status === 'working')
      .sort((a, b) => (a.role === 'sl' ? -1 : b.role === 'sl' ? 1 : 0));

    let changed = false;
    for (const ord of working) {
      if (ord.status !== 'working' || ord.price === undefined) continue;
      const target = ord.price;

      if (ord.type === 'limit') {
        if (ord.side === 'buy' && bar.low <= target) {
          // Gap-open favorable fill: if bar opens below buy limit, fill at open
          const fill = bar.open <= target ? bar.open : target;
          this.executeFill(ord, fill, bar.time, true);
          changed = true;
        } else if (ord.side === 'sell' && bar.high >= target) {
          const fill = bar.open >= target ? bar.open : target;
          this.executeFill(ord, fill, bar.time, true);
          changed = true;
        }
      } else if (ord.type === 'stop') {
        if (ord.side === 'sell' && bar.low <= target) {
          // GAP-OPEN FILL RULE: gap below stop-loss fills at bar.open - slippage (NEVER impossible stop price!)
          const trigger = bar.open <= target ? bar.open : target;
          this.executeFill(ord, Math.max(tick, trigger - slip), bar.time, false);
          changed = true;
        } else if (ord.side === 'buy' && bar.high >= target) {
          const trigger = bar.open >= target ? bar.open : target;
          this.executeFill(ord, trigger + slip, bar.time, false);
          changed = true;
        }
      }
    }

    // Mark-to-market active position
    const pos = this.positions.get(symbolId);
    if (pos) {
      pos.lastPrice = bar.close;
      pos.unrealizedPnl =
        pos.side === 'long'
          ? (bar.close - pos.avgEntryPrice) * pos.quantity
          : (pos.avgEntryPrice - bar.close) * pos.quantity;
      changed = true;
    }

    if (changed) this.emit();
  }

  private executeFill(order: PaperOrder, fillPrice: number, timestamp: number, isMaker: boolean): void {
    const sym = this.symbolMeta.get(order.symbol);
    const profile: FeeProfileId = sym ? inferFeeProfile(sym) : 'crypto_spot';
    const fees = calculateTradeFees(profile, order.side, fillPrice, order.quantity, isMaker);

    order.status = 'filled';
    order.filledAt = timestamp;
    order.fillPrice = fillPrice;
    order.feePaid = fees.total;

    this.cash -= fees.total;
    this.totalFeesPaid += fees.total;

    // OCO bracket cancellation: filling SL cancels sibling TP and vice versa
    if ((order.role === 'sl' || order.role === 'tp') && order.parentOrderId) {
      for (const sibling of this.orders.values()) {
        if (
          sibling.id !== order.id &&
          sibling.parentOrderId === order.parentOrderId &&
          sibling.status === 'working'
        ) {
          sibling.status = 'cancelled';
        }
      }
    }

    // Update position & realized P&L
    let realizedDelta = 0;
    const existing = this.positions.get(order.symbol);
    const signedQty = order.side === 'buy' ? order.quantity : -order.quantity;

    if (!existing) {
      this.positions.set(order.symbol, {
        symbol: order.symbol,
        side: signedQty > 0 ? 'long' : 'short',
        quantity: Math.abs(signedQty),
        avgEntryPrice: fillPrice,
        lastPrice: fillPrice,
        unrealizedPnl: 0,
        feeProfile: profile,
      });
    } else {
      const existingSigned = existing.side === 'long' ? existing.quantity : -existing.quantity;
      const newSigned = existingSigned + signedQty;

      if (Math.sign(existingSigned) === Math.sign(signedQty)) {
        // Adding to existing position
        const totalQty = existing.quantity + order.quantity;
        existing.avgEntryPrice =
          (existing.avgEntryPrice * existing.quantity + fillPrice * order.quantity) / totalQty;
        existing.quantity = totalQty;
      } else {
        // Closing or reversing position
        const closedQty = Math.min(existing.quantity, order.quantity);
        realizedDelta =
          existing.side === 'long'
            ? (fillPrice - existing.avgEntryPrice) * closedQty
            : (existing.avgEntryPrice - fillPrice) * closedQty;
        this.realizedPnl += realizedDelta;
        this.cash += realizedDelta;

        if (Math.abs(newSigned) < 1e-12) {
          this.positions.delete(order.symbol);
        } else if (Math.sign(newSigned) === Math.sign(existingSigned)) {
          existing.quantity = Math.abs(newSigned);
        } else {
          // Reversed into opposite direction
          this.positions.set(order.symbol, {
            symbol: order.symbol,
            side: newSigned > 0 ? 'long' : 'short',
            quantity: Math.abs(newSigned),
            avgEntryPrice: fillPrice,
            lastPrice: fillPrice,
            unrealizedPnl: 0,
            feeProfile: profile,
          });
        }
      }
    }

    this.fills.unshift({
      id: `fill_${this.seq++}`,
      orderId: order.id,
      symbol: order.symbol,
      side: order.side,
      quantity: order.quantity,
      fillPrice,
      feeTotal: fees.total,
      realizedPnl: realizedDelta,
      timestamp,
    });

    // Spawn OCO Bracket Stop-Loss & Take-Profit child orders when entry fills
    if (order.role === 'entry') {
      const exitSide: OrderSide = order.side === 'buy' ? 'sell' : 'buy';
      if (order.stopLoss !== undefined && Number.isFinite(order.stopLoss)) {
        const slId = `ord_${this.seq++}`;
        this.orders.set(slId, {
          id: slId,
          symbol: order.symbol,
          side: exitSide,
          type: 'stop',
          quantity: order.quantity,
          price: order.stopLoss,
          parentOrderId: order.id,
          role: 'sl',
          status: 'working',
          createdAt: timestamp,
        });
      }
      if (order.takeProfit !== undefined && Number.isFinite(order.takeProfit)) {
        const tpId = `ord_${this.seq++}`;
        this.orders.set(tpId, {
          id: tpId,
          symbol: order.symbol,
          side: exitSide,
          type: 'limit',
          quantity: order.quantity,
          price: order.takeProfit,
          parentOrderId: order.id,
          role: 'tp',
          status: 'working',
          createdAt: timestamp,
        });
      }
    }

    this.emit();
  }

  getSnapshot(): PaperAccountSnapshot {
    const positions = [...this.positions.values()].map((p) => ({ ...p }));
    const unrealizedPnl = positions.reduce((acc, p) => acc + p.unrealizedPnl, 0);
    const workingOrders = [...this.orders.values()]
      .filter((o) => o.status === 'working')
      .map((o) => ({ ...o }));

    return {
      startingCapital: this.startingCapital,
      cash: this.cash,
      equity: this.cash + unrealizedPnl,
      realizedPnl: this.realizedPnl,
      unrealizedPnl,
      totalFeesPaid: this.totalFeesPaid,
      positions,
      workingOrders,
      fills: [...this.fills],
    };
  }
}
