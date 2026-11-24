import { useMemo, useState } from 'react';
import type { PaperBrokerEngine } from '@openview/broker-sdk';
import { OrderbookEngine, buildSimulatedDomSnapshot } from '@openview/chart-types';
import type { OHLCVBar, SymbolInfo } from '@openview/protocol';

interface DomLadderPanelProps {
  symbol: SymbolInfo;
  latestBar: OHLCVBar | null;
  broker: PaperBrokerEngine;
  isDark: boolean;
}

export function DomLadderPanel({ symbol, latestBar, broker, isDark }: DomLadderPanelProps) {
  const [qty, setQty] = useState(1);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const refPrice = latestBar?.close ?? 100;
  const bookView = useMemo(() => {
    const engine = new OrderbookEngine(symbol.id);
    const seed = Math.max(1, Math.floor((latestBar?.time ?? 1000) / 1000) % 997);
    const snap = buildSimulatedDomSnapshot(symbol.id, refPrice, symbol.tickSize, 10, seed);
    engine.applyDelta(snap, !symbol.supportsOrderbook);
    return engine.getView(10);
  }, [symbol.id, symbol.tickSize, symbol.supportsOrderbook, refPrice, latestBar?.time]);

  const maxCum = Math.max(
    1,
    ...bookView.asks.map((a) => a.cumulative),
    ...bookView.bids.map((b) => b.cumulative),
  );

  const placeAtPrice = (side: 'buy' | 'sell', price: number) => {
    if (!latestBar) return;
    try {
      broker.placeOrder({
        symbolInfo: symbol,
        side,
        type: 'limit',
        quantity: Math.max(0.001, qty),
        price,
        currentBar: latestBar,
      });
      setStatusMsg(`Placed ${side.toUpperCase()} LIMIT ${qty} @ ${price.toFixed(symbol.precision)}`);
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <aside
      className={`flex w-72 shrink-0 flex-col border-l text-xs ${
        isDark ? 'border-[#2a2e39] bg-[#131722] text-[#d1d4dc]' : 'border-[#e0e3eb] bg-white text-[#131722]'
      }`}
    >
      <div className="flex items-center justify-between border-b border-[#2a2e39] px-3 py-2">
        <span className="font-semibold text-white">DOM Ladder · {symbol.ticker}</span>
        <span
          className={`rounded px-1.5 py-0.5 font-mono text-[9.5px] ${
            bookView.simulated ? 'bg-[#f7931a]/15 text-[#f7931a]' : 'bg-[#089981]/15 text-[#089981]'
          }`}
        >
          {bookView.simulated ? 'SIM L2 DEPTH' : 'L2 BOOK'}
        </span>
      </div>

      {/* Order Qty & Imbalance Bar */}
      <div className="border-b border-[#2a2e39] px-3 py-2 space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10.5px] text-[#787b86]">Click-to-Trade Qty</span>
          <input
            type="number"
            min="0.01"
            step="1"
            value={qty}
            onChange={(e) => setQty(Number(e.target.value))}
            className="w-20 rounded border border-[#2a2e39] bg-[#0b0e14] px-2 py-0.5 text-right font-mono text-xs text-white"
          />
        </div>
        <div className="flex items-center gap-1.5 text-[10px] font-mono">
          <span className="text-[#089981]">{(bookView.imbalanceRatio * 100).toFixed(0)}% Bid</span>
          <div className="flex h-1.5 flex-1 overflow-hidden rounded bg-[#2a2e39]">
            <div className="bg-[#089981]" style={{ width: `${bookView.imbalanceRatio * 100}%` }} />
            <div className="bg-[#f23645]" style={{ width: `${(1 - bookView.imbalanceRatio) * 100}%` }} />
          </div>
          <span className="text-[#f23645]">{((1 - bookView.imbalanceRatio) * 100).toFixed(0)}% Ask</span>
        </div>
      </div>

      {/* Column Headers */}
      <div className="grid grid-cols-3 border-b border-[#2a2e39] px-2 py-1 font-mono text-[10px] text-[#787b86]">
        <span>BID SIZE</span>
        <span className="text-center">PRICE</span>
        <span className="text-right">ASK SIZE</span>
      </div>

      {/* Ladder Rows */}
      <div className="flex-1 overflow-y-auto font-mono text-[11px]">
        {[...bookView.asks].reverse().map((row) => (
          <div
            key={`ask-${row.price}`}
            className="relative grid grid-cols-3 items-center border-b border-[#1e222d]/60 px-2 py-1 hover:bg-[#1e222d]"
          >
            <div
              className="pointer-events-none absolute top-0 right-0 bottom-0 bg-[#f23645]/15"
              style={{ width: `${(row.cumulative / maxCum) * 48}%` }}
            />
            <span className="text-[#5d606b]">—</span>
            <button
              onClick={() => placeAtPrice('sell', row.price)}
              title="Click to place Paper SELL LIMIT at this ask level"
              className="z-10 text-center font-semibold text-[#f23645] hover:underline"
            >
              {row.price.toFixed(symbol.precision)}
            </button>
            <span className="z-10 text-right text-[#d1d4dc]">{row.size.toFixed(1)}</span>
          </div>
        ))}

        {/* Spread Divider */}
        <div className="flex items-center justify-between bg-[#0b0e14] px-3 py-1 text-[10px] text-[#868993]">
          <span>SPREAD</span>
          <span className="font-semibold text-white">
            {bookView.spread !== null ? bookView.spread.toFixed(symbol.precision) : '—'}
          </span>
        </div>

        {bookView.bids.map((row) => (
          <div
            key={`bid-${row.price}`}
            className="relative grid grid-cols-3 items-center border-b border-[#1e222d]/60 px-2 py-1 hover:bg-[#1e222d]"
          >
            <div
              className="pointer-events-none absolute top-0 bottom-0 left-0 bg-[#089981]/15"
              style={{ width: `${(row.cumulative / maxCum) * 48}%` }}
            />
            <span className="z-10 text-[#d1d4dc]">{row.size.toFixed(1)}</span>
            <button
              onClick={() => placeAtPrice('buy', row.price)}
              title="Click to place Paper BUY LIMIT at this bid level"
              className="z-10 text-center font-semibold text-[#089981] hover:underline"
            >
              {row.price.toFixed(symbol.precision)}
            </button>
            <span className="text-right text-[#5d606b]">—</span>
          </div>
        ))}
      </div>

      {statusMsg && (
        <div className="border-t border-[#2a2e39] bg-[#0b0e14] px-3 py-1.5 font-mono text-[10px] text-[#089981]">
          {statusMsg}
        </div>
      )}
    </aside>
  );
}
