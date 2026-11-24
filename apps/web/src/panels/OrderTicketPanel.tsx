import { useState } from 'react';
import {
  calculateTradeFees,
  inferFeeProfile,
  type OrderType,
  type PaperAccountSnapshot,
  type PaperBrokerEngine,
} from '@openview/broker-sdk';
import type { OHLCVBar, SymbolInfo } from '@openview/protocol';

interface OrderTicketPanelProps {
  symbol: SymbolInfo;
  latestBar: OHLCVBar | null;
  account: PaperAccountSnapshot;
  broker: PaperBrokerEngine;
  isDark: boolean;
}

export function OrderTicketPanel({
  symbol,
  latestBar,
  account,
  broker,
  isDark,
}: OrderTicketPanelProps) {
  const [orderType, setOrderType] = useState<OrderType>('market');
  const [qtyStr, setQtyStr] = useState(String(Math.max(1, symbol.lotSize)));
  const [priceStr, setPriceStr] = useState('');
  const [slStr, setSlStr] = useState('');
  const [tpStr, setTpStr] = useState('');
  const [errMsg, setErrMsg] = useState('');

  const refPrice = latestBar?.close ?? 0;
  const qty = Math.max(0.0001, Number(qtyStr) || 1);
  const effectivePrice = orderType === 'market' ? refPrice : Number(priceStr) || refPrice;
  const profile = inferFeeProfile(symbol);
  const feeEst = calculateTradeFees(profile, 'sell', effectivePrice, qty);

  const submit = (side: 'buy' | 'sell') => {
    setErrMsg('');
    if (!latestBar && orderType === 'market') {
      setErrMsg('Waiting for market price...');
      return;
    }
    try {
      const limitPrice = orderType !== 'market' ? Number(priceStr) : undefined;
      if (orderType !== 'market' && (!limitPrice || !Number.isFinite(limitPrice))) {
        setErrMsg('Enter a valid Limit/Stop price');
        return;
      }
      const sl = slStr.trim() ? Number(slStr) : undefined;
      const tp = tpStr.trim() ? Number(tpStr) : undefined;
      broker.placeOrder({
        symbolInfo: symbol,
        side,
        type: orderType,
        quantity: qty,
        ...(limitPrice !== undefined ? { price: limitPrice } : {}),
        ...(sl !== undefined && Number.isFinite(sl) ? { stopLoss: sl } : {}),
        ...(tp !== undefined && Number.isFinite(tp) ? { takeProfit: tp } : {}),
        ...(latestBar ? { currentBar: latestBar } : {}),
      });
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const pos = account.positions.find((p) => p.symbol === symbol.id);

  return (
    <aside
      className={`flex h-full w-64 shrink-0 flex-col border-l text-xs ${
        isDark ? 'border-[#2a2e39] bg-[#131722]' : 'border-[#e0e3eb] bg-white'
      }`}
    >
      <div className="flex items-center justify-between border-b border-[#2a2e39] px-3 py-2">
        <span className="font-semibold uppercase tracking-wide text-[#089981]">
          Paper Trade
        </span>
        <button
          onClick={() => broker.reset()}
          className="text-[10px] text-[#787b86] hover:text-white"
          title="Reset Paper Account"
        >
          Reset
        </button>
      </div>

      {/* Account KPI Bar */}
      <div className="grid grid-cols-2 gap-1.5 border-b border-[#2a2e39] p-2.5 font-mono text-[10.5px]">
        <div>
          <div className="text-[#787b86]">Equity</div>
          <div className="font-semibold text-white">{account.equity.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
        </div>
        <div>
          <div className="text-[#787b86]">Open P&amp;L</div>
          <div className={account.unrealizedPnl >= 0 ? 'text-[#089981]' : 'text-[#f23645]'}>
            {account.unrealizedPnl >= 0 ? '+' : ''}
            {account.unrealizedPnl.toFixed(2)}
          </div>
        </div>
        <div>
          <div className="text-[#787b86]">Realized</div>
          <div className={account.realizedPnl >= 0 ? 'text-[#089981]' : 'text-[#f23645]'}>
            {account.realizedPnl >= 0 ? '+' : ''}
            {account.realizedPnl.toFixed(2)}
          </div>
        </div>
        <div>
          <div className="text-[#787b86]">Fees/Taxes</div>
          <div className="text-[#f7931a]">{account.totalFeesPaid.toFixed(2)}</div>
        </div>
      </div>

      {/* Order Form */}
      <div className="space-y-2 border-b border-[#2a2e39] p-3">
        <div className="flex items-center justify-between font-mono text-[11px]">
          <span className="font-semibold text-white">{symbol.ticker}</span>
          <span className="text-[#868993]">{refPrice > 0 ? refPrice.toFixed(symbol.precision) : '—'}</span>
        </div>

        <div className="grid grid-cols-3 gap-1">
          {(['market', 'limit', 'stop'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setOrderType(t)}
              className={`rounded py-1 font-mono text-[10.5px] uppercase ${
                orderType === t ? 'bg-[#2962ff] text-white' : 'bg-[#1e222d] text-[#868993]'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        <label className="block space-y-0.5">
          <span className="text-[10px] text-[#787b86]">Quantity (Lot: {symbol.lotSize})</span>
          <input
            type="number"
            step="any"
            value={qtyStr}
            onChange={(e) => setQtyStr(e.target.value)}
            className="w-full rounded border border-[#2a2e39] bg-[#0b0e14] px-2 py-1 font-mono text-xs text-white outline-none"
          />
        </label>

        {orderType !== 'market' && (
          <label className="block space-y-0.5">
            <span className="text-[10px] text-[#787b86]">{orderType === 'limit' ? 'Limit Price' : 'Stop Trigger'}</span>
            <input
              type="number"
              step="any"
              placeholder={refPrice.toFixed(symbol.precision)}
              value={priceStr}
              onChange={(e) => setPriceStr(e.target.value)}
              className="w-full rounded border border-[#2a2e39] bg-[#0b0e14] px-2 py-1 font-mono text-xs text-white outline-none"
            />
          </label>
        )}

        <div className="grid grid-cols-2 gap-1.5">
          <label className="block space-y-0.5">
            <span className="text-[10px] text-[#f23645]">Stop Loss</span>
            <input
              type="number"
              step="any"
              placeholder="Optional"
              value={slStr}
              onChange={(e) => setSlStr(e.target.value)}
              className="w-full rounded border border-[#2a2e39] bg-[#0b0e14] px-2 py-1 font-mono text-[11px] text-white outline-none"
            />
          </label>
          <label className="block space-y-0.5">
            <span className="text-[10px] text-[#089981]">Take Profit</span>
            <input
              type="number"
              step="any"
              placeholder="Optional"
              value={tpStr}
              onChange={(e) => setTpStr(e.target.value)}
              className="w-full rounded border border-[#2a2e39] bg-[#0b0e14] px-2 py-1 font-mono text-[11px] text-white outline-none"
            />
          </label>
        </div>

        <div className="rounded bg-[#0b0e14] px-2 py-1 font-mono text-[10px] text-[#787b86]">
          Est. Fee ({profile}): <span className="text-[#d1d4dc]">{feeEst.total.toFixed(2)} {symbol.currency}</span>
          {feeEst.stt > 0 && ` (STT ${feeEst.stt.toFixed(2)}, GST ${feeEst.gst.toFixed(2)})`}
        </div>

        {errMsg && <div className="text-[10.5px] text-[#f23645]">{errMsg}</div>}

        <div className="grid grid-cols-2 gap-1.5 pt-1">
          <button
            onClick={() => submit('buy')}
            className="rounded bg-[#089981] py-2 font-semibold text-white hover:bg-[#07826e]"
          >
            BUY
          </button>
          <button
            onClick={() => submit('sell')}
            className="rounded bg-[#f23645] py-2 font-semibold text-white hover:bg-[#d92d3b]"
          >
            SELL
          </button>
        </div>
      </div>

      {/* Active Position & Working Orders */}
      <div className="flex-1 overflow-y-auto p-2.5 space-y-2">
        {pos && latestBar && (
          <div className="rounded border border-[#2a2e39] bg-[#0b0e14] p-2 font-mono text-[11px]">
            <div className="flex items-center justify-between">
              <span className={pos.side === 'long' ? 'font-bold text-[#089981]' : 'font-bold text-[#f23645]'}>
                {pos.side.toUpperCase()} {pos.quantity}
              </span>
              <button
                onClick={() => broker.closePosition(symbol.id, latestBar)}
                className="rounded bg-[#2a2e39] px-1.5 py-0.5 text-[10px] text-white hover:bg-[#f23645]"
              >
                Close
              </button>
            </div>
            <div className="mt-1 flex justify-between text-[10px] text-[#868993]">
              <span>Avg {pos.avgEntryPrice.toFixed(symbol.precision)}</span>
              <span className={pos.unrealizedPnl >= 0 ? 'text-[#089981]' : 'text-[#f23645]'}>
                {pos.unrealizedPnl >= 0 ? '+' : ''}
                {pos.unrealizedPnl.toFixed(2)}
              </span>
            </div>
          </div>
        )}

        <div className="text-[10px] font-semibold uppercase text-[#787b86]">
          Working Orders ({account.workingOrders.length})
        </div>
        {account.workingOrders.map((o) => (
          <div
            key={o.id}
            className="flex items-center justify-between rounded border border-[#1e222d] bg-[#0b0e14] px-2 py-1.5 font-mono text-[10.5px]"
          >
            <div>
              <span className={o.side === 'buy' ? 'text-[#089981]' : 'text-[#f23645]'}>
                {o.role === 'sl' ? 'SL' : o.role === 'tp' ? 'TP' : o.side.toUpperCase()}
              </span>{' '}
              {o.quantity} @ {o.price?.toFixed(symbol.precision)}
            </div>
            <button
              onClick={() => broker.cancelOrder(o.id)}
              className="text-[#f23645] hover:underline"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </aside>
  );
}
