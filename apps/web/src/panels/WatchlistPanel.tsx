import { findSymbolById } from '@openview/datafeed-sdk';
import type { QuoteTick, SymbolInfo } from '@openview/protocol';

interface WatchlistPanelProps {
  symbolIds: string[];
  activeSymbolId: string;
  quotes: Record<string, QuoteTick>;
  isDark: boolean;
  onSelect: (symbol: SymbolInfo) => void;
  onOpenSearch: () => void;
}

export function WatchlistPanel({
  symbolIds,
  activeSymbolId,
  quotes,
  isDark,
  onSelect,
  onOpenSearch,
}: WatchlistPanelProps) {
  return (
    <aside
      className={`flex h-full w-60 shrink-0 flex-col border-l text-xs ${
        isDark ? 'border-[#2a2e39] bg-[#131722]' : 'border-[#e0e3eb] bg-white'
      }`}
    >
      <div
        className={`flex items-center justify-between border-b px-3 py-2 ${
          isDark ? 'border-[#2a2e39]' : 'border-[#e0e3eb]'
        }`}
      >
        <span className="font-semibold tracking-wide uppercase text-[#868993]">Watchlist</span>
        <button
          onClick={onOpenSearch}
          className="rounded px-1.5 py-0.5 text-sm text-[#868993] hover:bg-[#1e222d] hover:text-white"
          title="Add or search symbol (Ctrl+K)"
        >
          +
        </button>
      </div>

      <div
        className={`grid grid-cols-12 border-b px-3 py-1.5 text-[10px] font-medium uppercase text-[#787b86] ${
          isDark ? 'border-[#1e222d]' : 'border-[#eceff5]'
        }`}
      >
        <span className="col-span-5">Symbol</span>
        <span className="col-span-4 text-right">Last</span>
        <span className="col-span-3 text-right">Chg%</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {symbolIds.map((id) => {
          const sym = findSymbolById(id);
          if (!sym) return null;
          const q = quotes[id];
          const isActive = id === activeSymbolId;
          const pct = q?.changePct ?? 0;
          const color = pct >= 0 ? 'text-[#089981]' : 'text-[#f23645]';

          return (
            <button
              key={id}
              onClick={() => onSelect(sym)}
              className={`grid w-full grid-cols-12 items-center border-b px-3 py-2 text-left font-mono text-[11px] transition ${
                isDark ? 'border-[#1a1e2a]' : 'border-[#f0f3fa]'
              } ${
                isActive
                  ? isDark
                    ? 'bg-[#2962ff]/20'
                    : 'bg-[#2962ff]/10'
                  : isDark
                    ? 'hover:bg-[#1b202e]'
                    : 'hover:bg-[#f4f6fb]'
              }`}
            >
              <div className="col-span-5 overflow-hidden">
                <div className={`truncate font-semibold ${isDark ? 'text-white' : 'text-[#131722]'}`}>
                  {sym.ticker}
                </div>
                <div className="truncate text-[9.5px] text-[#787b86]">{sym.exchange}</div>
              </div>
              <div className={`col-span-4 text-right ${isDark ? 'text-[#d1d4dc]' : 'text-[#131722]'}`}>
                {q ? q.last.toFixed(sym.precision) : '—'}
              </div>
              <div className={`col-span-3 text-right ${q ? color : 'text-[#787b86]'}`}>
                {q ? `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%` : '—'}
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
