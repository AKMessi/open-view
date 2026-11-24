import { useMemo, useState } from 'react';
import { buildOptionChain } from '@openview/broker-sdk';
import type { SymbolInfo } from '@openview/protocol';

export interface OptionChainDrawerProps {
  open: boolean;
  symbol: SymbolInfo;
  spotPrice: number;
  isDark: boolean;
  onClose: () => void;
}

export default function OptionChainDrawer({
  open,
  symbol,
  spotPrice,
  isDark,
  onClose,
}: OptionChainDrawerProps) {
  const [dte, setDte] = useState(7);
  const chain = useMemo(
    () => buildOptionChain(symbol, Math.max(1, spotPrice), dte),
    [symbol, spotPrice, dte],
  );

  if (!open) return null;

  return (
    <section
      className={`flex h-72 shrink-0 flex-col border-t ${
        isDark ? 'border-[#2a2e39] bg-[#131722]' : 'border-[#e0e3eb] bg-white'
      }`}
    >
      <div className="flex items-center justify-between border-b border-[#2a2e39] px-3 py-1.5 text-xs">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-white">
            Option Chain · {symbol.ticker} (Spot: {spotPrice.toFixed(symbol.precision)})
          </span>
          <span className="font-mono text-[11px] text-[#6aa0ff]">{chain.expiryLabel}</span>
          {chain.sebiRuleNote && (
            <span className="rounded bg-[#f7931a]/15 px-2 py-0.5 text-[10px] text-[#f7931a]">
              {chain.sebiRuleNote}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <select
            value={dte}
            onChange={(e) => setDte(Number(e.target.value))}
            className="rounded border border-[#2a2e39] bg-[#1e222d] px-2 py-0.5 font-mono text-[11px] text-[#d1d4dc]"
          >
            <option value={5}>5 DTE</option>
            <option value={14}>14 DTE</option>
            <option value={30}>30 DTE (Monthly)</option>
          </select>
          <button onClick={onClose} className="px-1.5 text-xs text-[#787b86] hover:text-white">
            ✕
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto font-mono text-[11px]">
        <table className="w-full border-collapse text-right">
          <thead className="sticky top-0 bg-[#1a1f2d] text-[10px] uppercase text-[#787b86]">
            <tr>
              <th className="px-2 py-1.5">CE OI</th>
              <th className="px-2 py-1.5">CE IV%</th>
              <th className="px-2 py-1.5">CE Δ</th>
              <th className="px-2 py-1.5">CE Θ</th>
              <th className="px-2 py-1.5 text-[#089981]">CALL LTP</th>
              <th className="bg-[#242936] px-3 py-1.5 text-center text-white">STRIKE</th>
              <th className="px-2 py-1.5 text-[#f23645]">PUT LTP</th>
              <th className="px-2 py-1.5">PE Θ</th>
              <th className="px-2 py-1.5">PE Δ</th>
              <th className="px-2 py-1.5">PE IV%</th>
              <th className="px-2 py-1.5">PE OI</th>
            </tr>
          </thead>
          <tbody>
            {chain.rows.map((r) => (
              <tr
                key={r.strike}
                className={`border-b border-[#1e222d] ${
                  r.isAtm ? 'bg-[#2962ff]/15 font-semibold' : 'hover:bg-[#1a1f2d]/60'
                }`}
              >
                <td className="px-2 py-1 text-[#868993]">{(r.call.oi / 1000).toFixed(0)}K</td>
                <td className="px-2 py-1 text-[#868993]">{r.call.iv.toFixed(1)}</td>
                <td className="px-2 py-1 text-[#d1d4dc]">{r.call.delta.toFixed(2)}</td>
                <td className="px-2 py-1 text-[#f23645]">{r.call.thetaDaily.toFixed(1)}</td>
                <td className="px-2 py-1 font-semibold text-[#089981]">{r.call.price.toFixed(2)}</td>
                <td className="bg-[#1b202e] px-3 py-1 text-center font-bold text-white">
                  {r.strike}
                </td>
                <td className="px-2 py-1 font-semibold text-[#f23645]">{r.put.price.toFixed(2)}</td>
                <td className="px-2 py-1 text-[#f23645]">{r.put.thetaDaily.toFixed(1)}</td>
                <td className="px-2 py-1 text-[#d1d4dc]">{r.put.delta.toFixed(2)}</td>
                <td className="px-2 py-1 text-[#868993]">{r.put.iv.toFixed(1)}</td>
                <td className="px-2 py-1 text-[#868993]">{(r.put.oi / 1000).toFixed(0)}K</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
