import { useEffect, useRef, useState } from 'react';
import { isSpreadExpression, parseSpreadExpression, type SpreadAlignmentMode } from '@openview/chart-types';
import { findSymbolById, searchCatalog } from '@openview/datafeed-sdk';
import type { MarketCategory, SymbolInfo } from '@openview/protocol';

interface SymbolSearchModalProps {
  open: boolean;
  initialQuery?: string;
  spreadAlignment?: SpreadAlignmentMode;
  onChangeSpreadAlignment?: (mode: SpreadAlignmentMode) => void;
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

function resolveSpreadSymbolToken(rawToken: string): string {
  const exact = findSymbolById(rawToken);
  if (exact) return exact.id;
  const matches = searchCatalog(rawToken, 'all', 1);
  return matches[0]?.id ?? rawToken;
}

function buildSpreadSymbolInfo(rawExpr: string): { sym: SymbolInfo; legs: string[] } | null {
  if (!isSpreadExpression(rawExpr)) return null;
  try {
    const parsed = parseSpreadExpression(rawExpr);
    if (parsed.symbols.length === 0) return null;
    let normalizedExpr = parsed.expression;
    const resolvedLegs: string[] = [];
    for (const tok of parsed.symbols) {
      const resolved = resolveSpreadSymbolToken(tok);
      resolvedLegs.push(resolved);
      if (resolved !== tok) {
        normalizedExpr = normalizedExpr.split(tok).join(resolved);
      }
    }
    return {
      legs: resolvedLegs,
      sym: {
        id: `SPREAD:${normalizedExpr}`,
        ticker: normalizedExpr,
        description: `Synthetic Spread (${resolvedLegs.join(', ')})`,
        exchange: 'SPREAD',
        provider: 'synthetic_spread',
        market: 'index',
        segment: 'index',
        currency: 'RATIO',
        timezone: 'UTC',
        calendarId: 'CRYPTO',
        tickSize: 0.001,
        precision: 3,
        lotSize: 1,
        hasVolume: false,
        supportsOrderbook: false,
        supportsTicks: false,
        feedQuality: 'live_quote_zero_vol',
        symlogLinthresh: 0.1,
      },
    };
  } catch {
    return null;
  }
}

export function SymbolSearchModal({
  open,
  initialQuery = '',
  spreadAlignment = 'ffill',
  onChangeSpreadAlignment,
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

  const spreadCandidate = buildSpreadSymbolInfo(query);
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
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      if (spreadCandidate) {
        onSelect(spreadCandidate.sym);
        onClose();
      } else if (results[selectedIdx]) {
        onSelect(results[selectedIdx]!);
        onClose();
      }
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
            placeholder="Search symbol or enter Synthetic Spread (e.g. XAUUSD/XAGUSD, ETHUSDT/BTCUSDT, BANKNIFTY/NIFTY)"
            className="w-full bg-transparent text-sm text-white outline-none placeholder:text-[#787b86]"
          />
          <kbd className="rounded border border-[#2a2e39] px-1.5 py-0.5 font-mono text-[10px] text-[#787b86]">
            ESC
          </kbd>
        </div>

        {/* Synthetic Spread Preview Banner */}
        {spreadCandidate && (
          <div className="flex items-center justify-between border-b border-[#2962ff]/40 bg-[#2962ff]/10 px-4 py-2.5 text-xs">
            <div>
              <div className="font-mono font-semibold text-white">
                Spread Formula: {spreadCandidate.sym.ticker}
              </div>
              <div className="text-[11px] text-[#868993]">
                Clamped non-inverted wicks · Legs: {spreadCandidate.legs.join(' , ')}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {onChangeSpreadAlignment && (
                <select
                  value={spreadAlignment}
                  onChange={(e) => onChangeSpreadAlignment(e.target.value as SpreadAlignmentMode)}
                  className="rounded border border-[#2a2e39] bg-[#0b0e14] px-2 py-1 font-mono text-[10.5px] text-[#d1d4dc]"
                >
                  <option value="ffill">Align: Forward-Fill</option>
                  <option value="inner_join">Align: Inner Join</option>
                </select>
              )}
              <button
                onClick={() => {
                  onSelect(spreadCandidate.sym);
                  onClose();
                }}
                className="rounded bg-[#2962ff] px-3 py-1 font-semibold text-white hover:bg-[#1e53e5]"
              >
                Open Spread ↵
              </button>
            </div>
          </div>
        )}

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
              {spreadCandidate
                ? 'Press Enter to launch the Synthetic Spread chart above.'
                : 'No matching symbols. Try BTCUSDT, XAUUSD, NVDA, RELIANCE, NIFTY1!, or a spread like XAUUSD/XAGUSD.'}
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
