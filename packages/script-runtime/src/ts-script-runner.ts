import type { MainOverlayPlot, SubPaneSeriesPlot } from '@openview/chart-engine/model';
import type { OHLCVBar } from '@openview/protocol';
import type { WasmRuntimeApi } from './wasm-loader.ts';

export interface CustomScriptResult {
  overlays: MainOverlayPlot[];
  subPanePlots: SubPaneSeriesPlot[];
  logs: string[];
  elapsedMs: number;
  error?: string;
}

export const PINE_TEMPLATES: Record<string, { title: string; code: string }> = {
  pine_ema_cross: {
    title: 'Pine v6: Dual EMA Crossover',
    code: `//@version=6
indicator("Dual EMA Crossover", overlay=true)
fast = ta.ema(close, 9)
slow = ta.ema(close, 21)
plot(fast, title="EMA 9", color=color.green, linewidth=2)
plot(slow, title="EMA 21", color=color.red, linewidth=2)`,
  },
  pine_rsi_osc: {
    title: 'Pine v6: RSI(14) + EMA(9) Signal',
    code: `//@version=6
indicator("RSI + Signal", overlay=false)
r = ta.rsi(close, 14)
sig = ta.ema(r, 9)
hline(70, title="Overbought", color=color.red)
hline(30, title="Oversold", color=color.green)
plot(r, title="RSI 14", color=color.purple, linewidth=2)
plot(sig, title="Signal 9", color=color.orange)`,
  },
  pine_mid_channel: {
    title: 'Pine v6: Donchian Midline + History [1]',
    code: `//@version=6
indicator("Donchian Midline", overlay=true)
hi = ta.highest(high, 20)
lo = ta.lowest(low, 20)
mid = (hi + lo) / 2
plot(hi[1], title="Prev 20 High", color=color.green)
plot(mid, title="Midline", color=color.blue, linewidth=2)
plot(lo[1], title="Prev 20 Low", color=color.red)`,
  },
};

export function runPineScript(
  source: string,
  bars: readonly OHLCVBar[],
  wasm: WasmRuntimeApi,
): CustomScriptResult {
  const t0 = performance.now();
  const n = bars.length;
  const o = new Float64Array(n);
  const h = new Float64Array(n);
  const l = new Float64Array(n);
  const c = new Float64Array(n);
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const b = bars[i]!;
    o[i] = b.open;
    h[i] = b.high;
    l[i] = b.low;
    c[i] = b.close;
    v[i] = b.volume;
  }

  const parsed = JSON.parse(wasm.evalPineJson(source, o, h, l, c, v)) as {
    overlay: boolean;
    title: string;
    plots: Array<{ title: string; color: string; lineWidth: number; values: Array<number | null> }>;
    hlines: Array<{ price: number; title: string; color: string }>;
    diagnostics: Array<{ line: number; severity: string; message: string }>;
    error: string | null;
  };

  const logs = parsed.diagnostics.map((d) => `[L${d.line} ${d.severity.toUpperCase()}] ${d.message}`);
  if (parsed.error) {
    return {
      overlays: [],
      subPanePlots: [],
      logs,
      elapsedMs: Number((performance.now() - t0).toFixed(2)),
      error: parsed.error,
    };
  }

  const overlays: MainOverlayPlot[] = [];
  const subPanePlots: SubPaneSeriesPlot[] = [];
  const refLines = parsed.hlines.map((hl) => hl.price);

  for (let idx = 0; idx < parsed.plots.length; idx++) {
    const p = parsed.plots[idx]!;
    const arr = new Float64Array(p.values.length);
    for (let i = 0; i < p.values.length; i++) {
      arr[i] = p.values[i] === null ? Number.NaN : p.values[i]!;
    }
    if (parsed.overlay) {
      overlays.push({
        id: `pine_ov_${idx}`,
        title: p.title,
        kind: 'line',
        color: p.color,
        lineWidth: p.lineWidth,
        startBarIndex: 0,
        values: arr,
      });
    } else {
      subPanePlots.push({
        id: `pine_sub_${idx}`,
        title: p.title,
        color: p.color,
        kind: 'line',
        startBarIndex: 0,
        values: arr,
        ...(idx === 0 && refLines.length > 0 ? { refLines } : {}),
      });
    }
  }

  logs.unshift(`Pine VM compiled & evaluated "${parsed.title}" (${parsed.plots.length} plot(s))`);
  return {
    overlays,
    subPanePlots,
    logs,
    elapsedMs: Number((performance.now() - t0).toFixed(2)),
  };
}

export const SCRIPT_TEMPLATES: Record<string, { title: string; code: string }> = {
  ema_ribbon: {
    title: 'Dual EMA Momentum Ribbon',
    code: `// OpenView Custom Script SDK (Powered by Rust/WASM TA)
const fast = ctx.ta.ema(ctx.close, 9);
const slow = ctx.ta.ema(ctx.close, 21);

ctx.plotOverlay('EMA 9', fast, '#089981', 2);
ctx.plotOverlay('EMA 21', slow, '#f23645', 2);

const lastFast = fast[fast.length - 1];
const lastSlow = slow[slow.length - 1];
ctx.log('Trend bias: ' + (lastFast > lastSlow ? 'BULLISH' : 'BEARISH'));`,
  },
  bb_squeeze: {
    title: 'Bollinger + Hull MA Overlay',
    code: `// Bollinger Bands (ddof=0) + Hull MA 21
const bb = ctx.ta.bb(ctx.close, 20, 2);
const hull = ctx.ta.hma(ctx.close, 21);

ctx.plotBand('BB (20,2)', bb.basis, bb.upper, bb.lower, '#2962ff');
ctx.plotOverlay('HMA 21', hull, '#f7931a', 2);
ctx.log('Computed ' + ctx.close.length + ' bars in Rust/WASM');`,
  },
  custom_osc: {
    title: 'Custom RSI Smoothed Sub-Pane',
    code: `// RSI(14) + EMA(9) Signal on Sub-Pane
const r = ctx.ta.rsi(ctx.close, 14);
const sig = ctx.ta.ema(r, 9);

ctx.plotSubPane('RSI 14', r, '#ab47bc', [30, 70]);
ctx.plotSubPane('RSI Signal', sig, '#ff9800');
ctx.log('Latest RSI: ' + r[r.length - 1].toFixed(2));`,
  },
};

/**
 * Sandboxed Custom Script Executor:
 * Strips access to window/document/fetch/globalThis via strict parameter shadowing and
 * exposes typed Float64Array series + Rust/WASM TA primitives + plot outputs.
 */
export function runCustomIndicatorScript(
  code: string,
  bars: readonly OHLCVBar[],
  wasm: WasmRuntimeApi,
): CustomScriptResult {
  const t0 = performance.now();
  const n = bars.length;
  const open = new Float64Array(n);
  const high = new Float64Array(n);
  const low = new Float64Array(n);
  const close = new Float64Array(n);
  const volume = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const b = bars[i]!;
    open[i] = b.open;
    high[i] = b.high;
    low[i] = b.low;
    close[i] = b.close;
    volume[i] = b.volume;
  }

  const overlays: MainOverlayPlot[] = [];
  const subPanePlots: SubPaneSeriesPlot[] = [];
  const logs: string[] = [];

  const ctx = Object.freeze({
    open,
    high,
    low,
    close,
    volume,
    ta: Object.freeze({
      sma: (src: Float64Array, p: number) => wasm.taSma(src, p),
      ema: (src: Float64Array, p: number) => wasm.taEma(src, p),
      rma: (src: Float64Array, p: number) => wasm.taRma(src, p),
      wma: (src: Float64Array, p: number) => wasm.taWma(src, p),
      hma: (src: Float64Array, p: number) => wasm.taHma(src, p),
      rsi: (src: Float64Array, p: number) => wasm.taRsi(src, p),
      atr: (p: number) => wasm.taAtr(high, low, close, p),
      bb: (src: Float64Array, p: number, m = 2) => {
        const flat = wasm.taBollingerBands(src, p, m);
        return {
          basis: flat.subarray(0, n),
          upper: flat.subarray(n, 2 * n),
          lower: flat.subarray(2 * n, 3 * n),
        };
      },
      supertrend: (p = 10, f = 3) => {
        const flat = wasm.taSupertrend(high, low, close, p, f);
        return { line: flat.subarray(0, n), dir: flat.subarray(n, 2 * n) };
      },
    }),
    plotOverlay: (title: string, values: Float64Array, color = '#2962ff', lineWidth = 1.5) => {
      overlays.push({
        id: `custom_ov_${overlays.length}`,
        title,
        kind: 'line',
        color,
        lineWidth,
        startBarIndex: 0,
        values,
      });
    },
    plotBand: (
      title: string,
      basis: Float64Array,
      upper: Float64Array,
      lower: Float64Array,
      color = '#2962ff',
    ) => {
      overlays.push({
        id: `custom_band_${overlays.length}`,
        title,
        kind: 'band_fill',
        color,
        startBarIndex: 0,
        values: basis,
        extraValues: upper,
        lowerValues: lower,
      });
    },
    plotSubPane: (title: string, values: Float64Array, color = '#ab47bc', refLines?: number[]) => {
      subPanePlots.push({
        id: `custom_sub_${subPanePlots.length}`,
        title,
        color,
        kind: 'line',
        startBarIndex: 0,
        values,
        ...(refLines ? { refLines } : {}),
      });
    },
    log: (msg: unknown) => {
      if (logs.length < 50) logs.push(String(msg));
    },
  });

  try {
    // Shadow browser/node globals to prevent network or DOM side-effects from user scripts
    const fn = new Function(
      'ctx',
      'window',
      'document',
      'fetch',
      'XMLHttpRequest',
      'WebSocket',
      'globalThis',
      'localStorage',
      'indexedDB',
      `"use strict";\n${code}`,
    );
    fn(ctx, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined);
    return {
      overlays,
      subPanePlots,
      logs,
      elapsedMs: Number((performance.now() - t0).toFixed(2)),
    };
  } catch (err) {
    return {
      overlays: [],
      subPanePlots: [],
      logs,
      elapsedMs: Number((performance.now() - t0).toFixed(2)),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
