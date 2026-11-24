import { useEffect, useState } from 'react';
import type { MarketCategory } from '@openview/protocol';
import type { MarketClient, ScreenerRowClient } from '../services/market-client.ts';

export interface ScreenerDrawerProps {
  open: boolean;
  client: MarketClient;
  isDark: boolean;
  onSelectSymbol: (symbolId: string) => void;
  onClose: () => void;
}

const MARKETS: Array<{ id: MarketCategory | 'all'; label: string }> = [
  { id: 'all', label: 'All 4 Markets' },
  { id: 'crypto', label: 'Crypto' },
  { id: 'forex', label: 'Forex & Gold' },
  { id: 'us_equity', label: 'US Stocks' },
  { id: 'india_nse', label: 'India NSE / MCX' },
  { id: 'futures', label: 'Futures (1!)' },
];

export default function ScreenerDrawer({
  open,
  client,
  isDark,
  onSelectSymbol,
  onClose,
}: ScreenerDrawerProps) {
  const [market, setMarket] = useState<MarketCategory | 'all'>('all');
  const [emaFilter, setEmaFilter] = useState<'all' | 'bullish' | 'bearish'>('all');
  const [stFilter, setStFilter] = useState<'all' | 'bullish' | 'bearish'>('all');
  const [maxRsi, setMaxRsi] = useState<string>('');
  const [minRsi, setMinRsi] = useState<string>('');
  const [sortBy, setSortBy] = useState<'changePct' | 'rsi14' | 'atrPct' | 'volume'>('changePct');
  const [rows, setRows] = useState<ScreenerRowClient[]>([]);
  const [meta, setMeta] = useState<{ elapsedMs: number; cached: boolean; scannedCount: number } | null>(null);
  const [loading, setLoading] = useState(false);

  const runScan = async (refresh = false) => {
    setLoading(true);
    try {
      const res = await client.queryScreener({
        market,
        emaSignal: emaFilter,
        supertrend: stFilter,
        ...(minRsi !== '' ? { minRsi: Number(minRsi) } : {}),
        ...(maxRsi !== '' ? { maxRsi: Number(maxRsi) } : {}),
        sortBy,
        sortDir: 'desc',
        refresh,
      });
      setRows(res.rows);
      setMeta({ elapsedMs: res.elapsedMs, cached: res.cached, scannedCount: res.scannedCount });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) void runScan(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, market, emaFilter, stFilter, sortBy, minRsi, maxRsi]);

  if (!open) return null;

  return (
    <section
      className={`flex h-72 shrink-0 flex-col border-t text-xs ${
        isDark ? 'border-[#2a2e39] bg-[#131722] text-[#d1d4dc]' : 'border-[#e0e3eb] bg-white text-[#131722]'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#2a2e39] px-3 py-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-white">Multi-Market WASM Screener</span>
          <select
            value={market}
            onChange={(e) => setMarket(e.target.value as MarketCategory | 'all')}
            className="rounded border border-[#2a2e39] bg-[#1e222d] px-2 py-0.5 text-[11px] text-[#d1d4dc]"
          >
            {MARKETS.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
          <select
            value={emaFilter}
            onChange={(e) => setEmaFilter(e.target.value as 'all' | 'bullish' | 'bearish')}
            className="rounded border border-[#2a2e39] bg-[#1e222d] px-2 py-0.5 text-[11px] text-[#d1d4dc]"
          >
            <option value="all">EMA 20/50: Any</option>
            <option value="bullish">EMA 20 &gt; 50 (Bull)</option>
            <option value="bearish">EMA 20 &lt; 50 (Bear)</option>
          </select>
          <select
            value={stFilter}
            onChange={(e) => setStFilter(e.target.value as 'all' | 'bullish' | 'bearish')}
            className="rounded border border-[#2a2e39] bg-[#1e222d] px-2 py-0.5 text-[11px] text-[#d1d4dc]"
          >
            <option value="all">SuperTrend: Any</option>
            <option value="bullish">SuperTrend UP</option>
            <option value="bearish">SuperTrend DOWN</option>
          </select>
          <input
            type="number"
            placeholder="Min RSI"
            value={minRsi}
            onChange={(e) => setMinRsi(e.target.value)}
            className="w-16 rounded border border-[#2a2e39] bg-[#0b0e14] px-1.5 py-0.5 font-mono text-[11px] text-white"
          />
          <input
            type="number"
            placeholder="Max RSI"
            value={maxRsi}
            onChange={(e) => setMaxRsi(e.target.value)}
            className="w-16 rounded border border-[#2a2e39] bg-[#0b0e14] px-1.5 py-0.5 font-mono text-[11px] text-white"
          />
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as 'changePct' | 'rsi14' | 'atrPct' | 'volume')}
            className="rounded border border-[#2a2e39] bg-[#1e222d] px-2 py-0.5 text-[11px] text-[#d1d4dc]"
          >
            <option value="changePct">Sort: Change %</option>
            <option value="rsi14">Sort: RSI(14)</option>
            <option value="atrPct">Sort: ATR %</option>
            <option value="volume">Sort: Volume</option>
          </select>
        </div>

        <div className="flex items-center gap-2 font-mono text-[10.5px]">
          {meta && (
            <span className="text-[#089981]">
              {rows.length}/{meta.scannedCount} symbols · {meta.elapsedMs}ms {meta.cached ? '(cached)' : ''}
            </span>
          )}
          <button
            onClick={() => void runScan(true)}
            disabled={loading}
            className="rounded bg-[#2962ff] px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-[#1e53e5] disabled:opacity-50"
          >
            {loading ? 'Scanning...' : '↻ Rescan'}
          </button>
          <button onClick={onClose} className="px-1.5 text-xs text-[#787b86] hover:text-white">
            ✕
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        <table className="w-full border-collapse font-mono text-[11px]">
          <thead className="sticky top-0 bg-[#0b0e14] text-[10px] uppercase text-[#787b86]">
            <tr className="border-b border-[#2a2e39]">
              <th className="px-3 py-1.5 text-left">Symbol</th>
              <th className="px-2 py-1.5 text-left">Exchange</th>
              <th className="px-2 py-1.5 text-right">Last</th>
              <th className="px-2 py-1.5 text-right">Chg %</th>
              <th className="px-2 py-1.5 text-right">RSI(14)</th>
              <th className="px-2 py-1.5 text-center">EMA 20/50</th>
              <th className="px-2 py-1.5 text-center">SuperTrend</th>
              <th className="px-2 py-1.5 text-right">ATR %</th>
              <th className="px-2 py-1.5 text-right">BB Width %</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.symbol}
                onClick={() => onSelectSymbol(r.symbol)}
                className="cursor-pointer border-b border-[#1e222d]/60 hover:bg-[#1e222d]"
              >
                <td className="px-3 py-1.5 font-semibold text-white">{r.ticker}</td>
                <td className="px-2 py-1.5 text-[#787b86]">{r.exchange}</td>
                <td className="px-2 py-1.5 text-right text-white">{r.last.toFixed(2)}</td>
                <td className={`px-2 py-1.5 text-right ${r.changePct >= 0 ? 'text-[#089981]' : 'text-[#f23645]'}`}>
                  {r.changePct >= 0 ? '+' : ''}{r.changePct.toFixed(2)}%
                </td>
                <td className={`px-2 py-1.5 text-right ${r.rsi14 >= 70 ? 'text-[#f23645]' : r.rsi14 <= 30 ? 'text-[#089981]' : 'text-[#d1d4dc]'}`}>
                  {r.rsi14.toFixed(1)}
                </td>
                <td className="px-2 py-1.5 text-center">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] ${r.emaSignal === 'bullish' ? 'bg-[#089981]/15 text-[#089981]' : 'bg-[#f23645]/15 text-[#f23645]'}`}>
                    {r.emaSignal.toUpperCase()}
                  </span>
                </td>
                <td className="px-2 py-1.5 text-center">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] ${r.supertrendDir === 1 ? 'bg-[#089981]/15 text-[#089981]' : 'bg-[#f23645]/15 text-[#f23645]'}`}>
                    {r.supertrendDir === 1 ? '▲ UP' : '▼ DN'}
                  </span>
                </td>
                <td className="px-2 py-1.5 text-right text-[#d1d4dc]">{r.atrPct.toFixed(2)}%</td>
                <td className="px-2 py-1.5 text-right text-[#868993]">{r.bbWidthPct.toFixed(2)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
