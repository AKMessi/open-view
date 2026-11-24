export interface WasmRuntimeApi {
  version: string;
  taSma: (values: Float64Array, period: number) => Float64Array;
  taEma: (values: Float64Array, period: number) => Float64Array;
  taRma: (values: Float64Array, period: number) => Float64Array;
  taWma: (values: Float64Array, period: number) => Float64Array;
  taHma: (values: Float64Array, period: number) => Float64Array;
  taVwma: (values: Float64Array, volume: Float64Array, period: number) => Float64Array;
  taRsi: (values: Float64Array, period: number) => Float64Array;
  taMacd: (values: Float64Array, fast: number, slow: number, signal: number) => Float64Array;
  taAtr: (high: Float64Array, low: Float64Array, close: Float64Array, period: number) => Float64Array;
  taBollingerBands: (values: Float64Array, period: number, mult: number) => Float64Array;
  taKeltnerChannels: (high: Float64Array, low: Float64Array, close: Float64Array, period: number, mult: number) => Float64Array;
  taDonchianChannels: (high: Float64Array, low: Float64Array, period: number) => Float64Array;
  taSupertrend: (high: Float64Array, low: Float64Array, close: Float64Array, period: number, factor: number) => Float64Array;
  taStochastic: (high: Float64Array, low: Float64Array, close: Float64Array, k: number, sk: number, d: number) => Float64Array;
  taAdxDmi: (high: Float64Array, low: Float64Array, close: Float64Array, period: number) => Float64Array;
  taCci: (high: Float64Array, low: Float64Array, close: Float64Array, period: number) => Float64Array;
  taObv: (close: Float64Array, volume: Float64Array) => Float64Array;
  taMfi: (high: Float64Array, low: Float64Array, close: Float64Array, volume: Float64Array, period: number) => Float64Array;
  taSessionVwap: (high: Float64Array, low: Float64Array, close: Float64Array, volume: Float64Array, breaks: Uint8Array) => Float64Array;
  runBacktestJson: (
    open: Float64Array,
    high: Float64Array,
    low: Float64Array,
    close: Float64Array,
    strategyId: number,
    paramA: number,
    paramB: number,
    stopLossPct: number,
    takeProfitPct: number,
    feeBps: number,
    slippageBps: number,
    initialCapital: number,
  ) => string;
  evalPineJson: (
    source: string,
    open: Float64Array,
    high: Float64Array,
    low: Float64Array,
    close: Float64Array,
    volume: Float64Array,
  ) => string;
}

let cachedPromise: Promise<WasmRuntimeApi> | null = null;

export function loadBrowserWasm(): Promise<WasmRuntimeApi> {
  if (!cachedPromise) {
    cachedPromise = (async () => {
      const mod = await import('./wasm-pkg/openview_wasm.js');
      await mod.default();
      return {
        version: mod.openview_wasm_version(),
        taSma: (v, p) => mod.ta_sma(v, p),
        taEma: (v, p) => mod.ta_ema(v, p),
        taRma: (v, p) => mod.ta_rma(v, p),
        taWma: (v, p) => mod.ta_wma(v, p),
        taHma: (v, p) => mod.ta_hma(v, p),
        taVwma: (v, vol, p) => mod.ta_vwma(v, vol, p),
        taRsi: (v, p) => mod.ta_rsi(v, p),
        taMacd: (v, f, s, sig) => mod.ta_macd(v, f, s, sig),
        taAtr: (h, l, c, p) => mod.ta_atr(h, l, c, p),
        taBollingerBands: (v, p, m) => mod.ta_bollinger_bands(v, p, m),
        taKeltnerChannels: (h, l, c, p, m) => mod.ta_keltner_channels(h, l, c, p, m),
        taDonchianChannels: (h, l, p) => mod.ta_donchian_channels(h, l, p),
        taSupertrend: (h, l, c, p, f) => mod.ta_supertrend(h, l, c, p, f),
        taStochastic: (h, l, c, k, sk, d) => mod.ta_stochastic(h, l, c, k, sk, d),
        taAdxDmi: (h, l, c, p) => mod.ta_adx_dmi(h, l, c, p),
        taCci: (h, l, c, p) => mod.ta_cci(h, l, c, p),
        taObv: (c, vol) => mod.ta_obv(c, vol),
        taMfi: (h, l, c, vol, p) => mod.ta_mfi(h, l, c, vol, p),
        taSessionVwap: (h, l, c, vol, b) => mod.ta_session_vwap(h, l, c, vol, b),
        runBacktestJson: (o, h, l, c, sid, pa, pb, sl, tp, fee, slip, cap) =>
          mod.backtest_run_json(o, h, l, c, sid, pa, pb, sl, tp, fee, slip, cap),
        evalPineJson: (src, o, h, l, c, v) => mod.pine_eval_json(src, o, h, l, c, v),
      };
    })();
  }
  return cachedPromise;
}
