import { useState } from 'react';
import type { OHLCVBar } from '@openview/protocol';
import { loadBrowserWasm } from '@openview/script-runtime';

export interface BacktestReport {
  initialCapital: number;
  finalEquity: number;
  netProfit: number;
  netProfitPct: number;
  totalTrades: number;
  winningTrades: number;
  winRatePct: number;
  profitFactor: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  totalFees: number;
  equityCurve: number[];
  tradePnls: number[];
}

export interface StrategyTesterDrawerProps {
  open: boolean;
  symbolTicker: string;
  bars: readonly OHLCVBar[];
  isSyntheticChart?: boolean;
  chartModeLabel?: string;
  isDark: boolean;
  onClose: () => void;
}

export default function StrategyTesterDrawer({
  open,
  symbolTicker,
  bars,
  isSyntheticChart = false,
  chartModeLabel,
  isDark,
  onClose,
}: StrategyTesterDrawerProps) {
  const [strategyId, setStrategyId] = useState(0);
  const [paramA, setParamA] = useState(12);
  const [paramB, setParamB] = useState(26);
  const [slPct, setSlPct] = useState(2);
  const [tpPct, setTpPct] = useState(6);
  const [feeBps, setFeeBps] = useState(5);
  const [report, setReport] = useState<BacktestReport | null>(null);
  const [runMs, setRunMs] = useState<number | null>(null);

  if (!open) return null;

  const runNow = async () => {
    const n = bars.length;
    if (n < 30) return;
    const o = new Float64Array(n);
    const h = new Float64Array(n);
    const l = new Float64Array(n);
    const c = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      o[i] = bars[i]!.open;
      h[i] = bars[i]!.high;
      l[i] = bars[i]!.low;
      c[i] = bars[i]!.close;
    }
    const wasm = await loadBrowserWasm();
    const t0 = performance.now();
    const json = wasm.runBacktestJson(o, h, l, c, strategyId, paramA, paramB, slPct, tpPct, feeBps, 1, 100_000);
    setRunMs(Number((performance.now() - t0).toFixed(2)));
    setReport(JSON.parse(json) as BacktestReport);
  };

  const buildSvgPath = (curve: number[]): string => {
    if (curve.length < 2) return '';
    const min = Math.min(...curve);
    const max = Math.max(...curve);
    const span = Math.max(1, max - min);
    return curve
      .map((v, i) => {
        const x = (i / (curve.length - 1)) * 420;
        const y = 78 - ((v - min) / span) * 70;
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  };

  return (
    <section
      className={`flex h-64 shrink-0 flex-col border-t ${
        isDark ? 'border-[#2a2e39] bg-[#131722]' : 'border-[#e0e3eb] bg-white'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#2a2e39] px-3 py-1.5 text-xs">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-white">Strategy Tester (Rust/WASM · Gap-Open Realism)</span>
          <select
            value={strategyId}
            onChange={(e) => setStrategyId(Number(e.target.value))}
            className="rounded border border-[#2a2e39] bg-[#1e222d] px-2 py-0.5 text-[11px] text-[#d1d4dc]"
          >
            <option value={0}>EMA Crossover</option>
            <option value={1}>RSI Mean Reversion (30/70)</option>
            <option value={2}>SuperTrend Trend Following</option>
          </select>
          <span className="text-[11px] text-[#787b86]">P1</span>
          <input
            type="number"
            value={paramA}
            onChange={(e) => setParamA(Number(e.target.value))}
            className="w-12 rounded border border-[#2a2e39] bg-[#0b0e14] px-1.5 py-0.5 font-mono text-[11px] text-white"
          />
          <span className="text-[11px] text-[#787b86]">P2</span>
          <input
            type="number"
            value={paramB}
            onChange={(e) => setParamB(Number(e.target.value))}
            className="w-12 rounded border border-[#2a2e39] bg-[#0b0e14] px-1.5 py-0.5 font-mono text-[11px] text-white"
          />
          <span className="text-[11px] text-[#f23645]">SL%</span>
          <input
            type="number"
            step="0.5"
            value={slPct}
            onChange={(e) => setSlPct(Number(e.target.value))}
            className="w-12 rounded border border-[#2a2e39] bg-[#0b0e14] px-1.5 py-0.5 font-mono text-[11px] text-white"
          />
          <span className="text-[11px] text-[#089981]">TP%</span>
          <input
            type="number"
            step="0.5"
            value={tpPct}
            onChange={(e) => setTpPct(Number(e.target.value))}
            className="w-12 rounded border border-[#2a2e39] bg-[#0b0e14] px-1.5 py-0.5 font-mono text-[11px] text-white"
          />
          <span className="text-[11px] text-[#787b86]">Fee bps</span>
          <input
            type="number"
            value={feeBps}
            onChange={(e) => setFeeBps(Number(e.target.value))}
            className="w-12 rounded border border-[#2a2e39] bg-[#0b0e14] px-1.5 py-0.5 font-mono text-[11px] text-white"
          />
        </div>

        <div className="flex items-center gap-2">
          {runMs !== null && (
            <span className="font-mono text-[10.5px] text-[#089981]">
              {bars.length.toLocaleString()} bars in {runMs}ms
            </span>
          )}
          <button
            onClick={() => void runNow()}
            className="rounded bg-[#2962ff] px-3 py-1 text-[11px] font-semibold text-white hover:bg-[#1e53e5]"
          >
            ▶ Run Backtest ({symbolTicker})
          </button>
          <button onClick={onClose} className="px-1.5 text-xs text-[#787b86] hover:text-white">
            ✕
          </button>
        </div>
      </div>

      {isSyntheticChart && (
        <div className="flex items-center gap-2 border-b border-[#f7931a]/40 bg-[#f7931a]/15 px-3 py-1 text-[11px] font-medium text-[#f7931a]">
          <span>⚠ Synthetic-Fill Warning ({chartModeLabel ?? 'Non-Time / Heikin Ashi'}):</span>
          <span className="text-[#f5c26b]">
            Synthetic chart prices differ from executable market OHLCV prices. Switch to Standard Candles for production-grade fill realism.
          </span>
        </div>
      )}

      {!report ? (
        <div className="flex flex-1 items-center justify-center text-xs text-[#787b86]">
          Click "Run Backtest" to simulate deterministic Gap-Open Slippage fills across {bars.length.toLocaleString()} bars in WebAssembly.
        </div>
      ) : (
        <div className="grid flex-1 grid-cols-12 gap-3 overflow-y-auto p-3">
          <div className="col-span-6 grid grid-cols-3 gap-2 font-mono text-xs">
            <div className="rounded border border-[#2a2e39] bg-[#0b0e14] p-2">
              <div className="text-[10px] text-[#787b86]">Net Profit</div>
              <div className={report.netProfit >= 0 ? 'font-bold text-[#089981]' : 'font-bold text-[#f23645]'}>
                {report.netProfit >= 0 ? '+' : ''}{report.netProfit.toFixed(2)} ({report.netProfitPct.toFixed(2)}%)
              </div>
            </div>
            <div className="rounded border border-[#2a2e39] bg-[#0b0e14] p-2">
              <div className="text-[10px] text-[#787b86]">Win Rate</div>
              <div className="font-bold text-white">
                {report.winRatePct.toFixed(1)}% ({report.winningTrades}/{report.totalTrades})
              </div>
            </div>
            <div className="rounded border border-[#2a2e39] bg-[#0b0e14] p-2">
              <div className="text-[10px] text-[#787b86]">Profit Factor</div>
              <div className="font-bold text-white">{report.profitFactor.toFixed(2)}</div>
            </div>
            <div className="rounded border border-[#2a2e39] bg-[#0b0e14] p-2">
              <div className="text-[10px] text-[#787b86]">Max Drawdown</div>
              <div className="font-bold text-[#f23645]">-{report.maxDrawdownPct.toFixed(2)}%</div>
            </div>
            <div className="rounded border border-[#2a2e39] bg-[#0b0e14] p-2">
              <div className="text-[10px] text-[#787b86]">Sharpe Ratio</div>
              <div className="font-bold text-white">{report.sharpeRatio.toFixed(2)}</div>
            </div>
            <div className="rounded border border-[#2a2e39] bg-[#0b0e14] p-2">
              <div className="text-[10px] text-[#787b86]">Total Fees</div>
              <div className="font-bold text-[#f7931a]">{report.totalFees.toFixed(2)}</div>
            </div>
          </div>

          <div className="col-span-6 flex flex-col rounded border border-[#2a2e39] bg-[#0b0e14] p-2">
            <div className="mb-1 text-[10px] font-semibold uppercase text-[#787b86]">Equity Curve</div>
            <svg viewBox="0 0 420 84" className="h-full w-full">
              <path
                d={buildSvgPath(report.equityCurve)}
                fill="none"
                stroke={report.netProfit >= 0 ? '#089981' : '#f23645'}
                strokeWidth="2"
              />
            </svg>
          </div>
        </div>
      )}
    </section>
  );
}
