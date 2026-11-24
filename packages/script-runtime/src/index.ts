export interface WasmRuntimeApi {
  version: string;
  taSma: (values: Float64Array, period: number) => Float64Array;
  taEma: (values: Float64Array, period: number) => Float64Array;
  taRma: (values: Float64Array, period: number) => Float64Array;
  taRsi: (values: Float64Array, period: number) => Float64Array;
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
        taRsi: (v, p) => mod.ta_rsi(v, p),
      };
    })();
  }
  return cachedPromise;
}
