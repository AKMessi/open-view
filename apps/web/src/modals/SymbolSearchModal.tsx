import { useEffect, useRef, useState } from 'react';
import { isSpreadExpression, parseSpreadExpression, type SpreadAlignmentMode } from '@openview/chart-types';
import { findSymbolById, searchCatalog } from '@openview/datafeed-sdk';
import type { MarketCategory, SymbolInfo } from '@openview/protocol';
import type { MarketClient } from '../services/market-client.ts';

interface SymbolSearchModalProps {
  open: boolean;
  initialQuery?: string;
  client: MarketClient;
  watchlistIds: readonly string[];
  spreadAlignment?: SpreadAlignmentMode;
  onChangeSpreadAlignment?: (mode: SpreadAlignmentMode) => void;
  onToggleWatchlist: (symbolId: string) => void;
  onClose: () => void;
  onSelect: (symbol: SymbolInfo) => void;
}

const TABS: Array<{ id: MarketCategory | 'all'; label: string }> = [
  { id: 'all', label: 'All Global' },
  { id: 'crypto', label: 'Crypto (Spot + Perps)' },
  { id: 'forex', label: 'Forex & Commodities' },
  { id: 'us_equity', label: 'US Stocks & ETFs' },
  { id: 'india_nse', label: 'India NSE / BSE / MCX' },
  { id: 'futures', label: 'Futures' },
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
  client,
  watchlistIds,
  spreadAlignment = 'ffill',
  onChangeSpreadAlignment,
  onToggleWatchlist,
  onClose,
  onSelect,
}: SymbolSearchModalProps) {
  const [query, setQuery] = useState(initialQuery);
  const [tab, setTab] = useState<MarketCategory | 'all'>('all');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [results, setResults] = useState<SymbolInfo[]>(() => searchCatalog('', 'all', 60));
  const [totalCached, setTotalCached] = useState<number | null>(null);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setQuery(initialQuery);
      setSelectedIdx(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open, initialQuery]);

  // Live Universal Directory + Global Search (debounced 150ms)
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // Instant local match first so UI feels 0ms responsive
    setResults(searchCatalog(query, tab, 60));
    setSearching(true);

    const timer = window.setTimeout(() => {
      void client.searchSymbols(query, tab, 80).then((res) => {
        if (cancelled) return;
        setResults(res.symbols);
        if (res.totalCached !== undefined) setTotalCached(res.totalCached);
        setSearching(false);
      });
    }, query.trim().length > 0 ? 150 : 10);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, query, tab, client]);

  if (!open) return null;

  const spreadCandidate = buildSpreadSymbolInfo(query);
  const watchlistSet = new Set(watchlistIds);

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
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/65 pt-14 backdrop-blur-xs"
      onClick={onClose}
    >
      <div
        className="flex max-h-[78vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-[#2a2e39] bg-[#131722] shadow-2xl"
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
            placeholder="Search ANY crypto, US stock, Indian NSE/BSE stock, Forex, Gold, Oil, or Spread (e.g. PEPE, PLTR, SUZLON, XAUUSD/XAGUSD)"
            className="w-full bg-transparent text-sm text-white outline-none placeholder:text-[#787b86]"
          />
          {totalCached !== null && (
            <span className="shrink-0 rounded bg-[#089981]/15 px-1.5 py-0.5 font-mono text-[10px] text-[#089981]">
              {totalCached.toLocaleString()}+ + Global
            </span>
          )}
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

        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#2a2e39] px-3 py-2">
          <div className="flex flex-wrap gap-1">
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
          {searching && (
            <span className="font-mono text-[10px] text-[#6aa0ff]">Searching global markets...</span>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          {results.length === 0 ? (
            <div className="p-8 text-center text-xs text-[#787b86]">
              {searching
                ? 'Querying global exchange directory...'
                : spreadCandidate
                  ? 'Press Enter to launch the Synthetic Spread chart above.'
                  : 'No matching symbols found. Try any Binance pair (PEPEUSDT, SUIUSDT), Hyperliquid perp (HYPE), US stock (PLTR, AMD), NSE stock (SUZLON, ZOMATO/ETERNAL, HAL), Forex (AUDUSD, GBPJPY), or a spread (XAUUSD/XAGUSD).'}
            </div>
          ) : (
            results.map((sym, idx) => {
              const inWl = watchlistSet.has(sym.id);
              return (
                <div
                  key={sym.id}
                  onMouseEnter={() => setSelectedIdx(idx)}
                  className={`flex w-full items-center justify-between border-b border-[#1e222d] px-4 py-2 text-left text-xs transition ${
                    idx === selectedIdx ? 'bg-[#1e222d]' : ''
                  }`}
                >
                  <button
                    onClick={() => {
                      onSelect(sym);
                      onClose();
                    }}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  >
                    <span className="w-32 shrink-0 truncate font-mono font-semibold text-white">
                      {sym.ticker}
                    </span>
                    <span className="truncate text-[#868993]">{sym.description}</span>
                  </button>

                  <div className="ml-3 flex shrink-0 items-center gap-2 font-mono text-[10px]">
                    <span className="rounded bg-[#2a2e39] px-1.5 py-0.5 text-[#d1d4dc]">
                      {sym.exchange}
                    </span>
                    <span className="w-10 text-right text-[#787b86]">{sym.currency}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleWatchlist(sym.id);
                      }}
                      title={inWl ? 'Remove from Watchlist' : 'Add to Watchlist'}
                      className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold transition ${
                        inWl
                          ? 'border-[#089981]/50 bg-[#089981]/20 text-[#089981]'
                          : 'border-[#2a2e39] text-[#868993] hover:border-[#2962ff] hover:text-white'
                      }`}
                    >
                      {inWl ? '✓ WL' : '+ WL'}
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
