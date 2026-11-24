import { useEffect, useRef, useState } from 'react';
import { searchCatalog } from '@openview/datafeed-sdk';
import type { MarketCategory, SymbolInfo } from '@openview/protocol';

interface SymbolSearchModalProps {
  open: boolean;
  initialQuery?: string;
  onClose: () => void;
  onSelect: (symbol: SymbolInfo) => void;
}

const TABS: Array<{ id: MarketCategory | 'all'; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'crypto', label: 'Crypto' },
  { id: 'forex', label: 'Forex & Gold' },
  { id: 'us_equity', label: 'US Stocks' },
  { id: 'india_nse', label: 'India NSE / MCX' },
  { id: 'futures', label: 'Futures (1!)' },
];

export function SymbolSearchModal({
  open,
  initialQuery = '',
  onClose,
  onSelect,
}: SymbolSearchModalProps) {
  const [query, setQuery] = useState(initialQuery);
  const [tab, setTab] = useState<MarketCategory | 'all'>('all');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setQuery(initialQuery);
      setSelectedIdx(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open, initialQuery]);

  if (!open) return null;

  const results = searchCatalog(query, tab, 50);

  const handleKeyDown = (ev: React.KeyboardEvent) => {
    if (ev.key === 'Escape') {
      onClose();
    } else if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      setSelectedIdx((i) => Math.min(results.length - 1, i + 1));
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      setSelectedIdx((i) => Math.max(0, i - 1));
    } else if (ev.key === 'Enter' && results[selectedIdx]) {
      ev.preventDefault();
      onSelect(results[selectedIdx]!);
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/65 pt-16 backdrop-blur-xs"
      onClick={onClose}
    >
      <div
        className="flex max-h-[75vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-[#2a2e39] bg-[#131722] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center gap-2 border-b border-[#2a2e39] px-4 py-3">
          <span className="text-sm text-[#787b86]">⌕</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIdx(0);
            }}
            placeholder="Search symbol across Crypto, Forex/Gold, US Stocks, India NSE/MCX (e.g. BTCUSDT, XAUUSD, NVDA, RELIANCE, NIFTY1!)"
            className="w-full bg-transparent text-sm text-white outline-none placeholder:text-[#787b86]"
          />
          <kbd className="rounded border border-[#2a2e39] px-1.5 py-0.5 font-mono text-[10px] text-[#787b86]">
            ESC
          </kbd>
        </div>

        <div className="flex gap-1 border-b border-[#2a2e39] px-3 py-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => {
                setTab(t.id);
                setSelectedIdx(0);
              }}
              className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
                tab === t.id
                  ? 'bg-[#2962ff] text-white'
                  : 'text-[#868993] hover:bg-[#1e222d] hover:text-white'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto">
          {results.length === 0 ? (
            <div className="p-8 text-center text-xs text-[#787b86]">
              No matching symbols. Try BTCUSDT, XAUUSD, EURUSD, NVDA, RELIANCE, or NIFTY1!.
            </div>
          ) : (
            results.map((sym, idx) => (
              <button
                key={sym.id}
                onClick={() => {
                  onSelect(sym);
                  onClose();
                }}
                onMouseEnter={() => setSelectedIdx(idx)}
                className={`flex w-full items-center justify-between border-b border-[#1e222d] px-4 py-2.5 text-left text-xs transition ${
                  idx === selectedIdx ? 'bg-[#1e222d]' : ''
                }`}
              >
                <div className="flex items-center gap-3">
                  <span className="w-28 font-mono font-semibold text-white">{sym.ticker}</span>
                  <span className="text-[#868993]">{sym.description}</span>
                </div>
                <div className="flex items-center gap-2 font-mono text-[10px]">
                  <span className="rounded bg-[#2a2e39] px-1.5 py-0.5 text-[#d1d4dc]">
                    {sym.exchange}
                  </span>
                  <span className="text-[#787b86]">{sym.currency}</span>
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
