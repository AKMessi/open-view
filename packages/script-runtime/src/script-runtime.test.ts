import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { OHLCVBar } from '@openview/protocol';
import {
  PINE_TEMPLATES,
  SCRIPT_TEMPLATES,
  runCustomIndicatorScript,
  runPineScript,
  type WasmRuntimeApi,
} from './index.ts';

function makeBars(count = 60): OHLCVBar[] {
  const out: OHLCVBar[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const open = price;
    const drift = Math.sin(i * 0.25) * 2.5 + 0.4;
    const close = open + drift;
    out.push({
      time: 1_700_000_000_000 + i * 60_000,
      open,
      high: Math.max(open, close) + 1.2,
      low: Math.min(open, close) - 1.1,
      close,
      volume: 1000 + i * 20,
    });
    price = close;
  }
  return out;
}

describe('Pine v5/v6 WASM VM & Custom Script Runtime', () => {
  let wasm: WasmRuntimeApi;

  beforeAll(async () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const wasmBytes = fs.readFileSync(path.join(dir, 'wasm-pkg/openview_wasm_bg.wasm'));
    const mod = await import('./wasm-pkg/openview_wasm.js');
    await mod.default(wasmBytes);
    wasm = {
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
  });

  it('executes all Pine v6 built-in templates cleanly via Rust/WASM', () => {
    const bars = makeBars(60);

    const emaRes = runPineScript(PINE_TEMPLATES.pine_ema_cross!.code, bars, wasm);
    expect(emaRes.error).toBeUndefined();
    expect(emaRes.overlays).toHaveLength(2);
    expect(Number.isFinite(emaRes.overlays[0]!.values[59])).toBe(true);

    const rsiRes = runPineScript(PINE_TEMPLATES.pine_rsi_osc!.code, bars, wasm);
    expect(rsiRes.error).toBeUndefined();
    expect(rsiRes.subPanePlots).toHaveLength(2);
    expect(rsiRes.subPanePlots[0]!.refLines).toEqual([70, 30]);

    const midRes = runPineScript(PINE_TEMPLATES.pine_mid_channel!.code, bars, wasm);
    expect(midRes.error).toBeUndefined();
    expect(midRes.overlays).toHaveLength(3);
  });

  it('surfaces Pine static repainting linter warnings in logs', () => {
    const bars = makeBars(40);
    const risky = `//@version=6
indicator("Conditional TA", overlay=true)
x = close > open ? ta.ema(close, 5) : ta.sma(close, 5)
plot(x, title="Risky")`;
    const res = runPineScript(risky, bars, wasm);
    expect(res.error).toBeUndefined();
    expect(res.logs.some((l) => l.includes('WARNING') && l.includes('Conditional Series'))).toBe(true);
  });

  it('sandboxes TypeScript SDK scripts from network/DOM globals while running WASM TA', () => {
    const bars = makeBars(50);
    const res = runCustomIndicatorScript(SCRIPT_TEMPLATES.bb_squeeze!.code, bars, wasm);
    expect(res.error).toBeUndefined();
    expect(res.overlays).toHaveLength(2);

    const escapeAttempt = runCustomIndicatorScript(
      `if (typeof fetch !== 'undefined' || typeof globalThis !== 'undefined') throw new Error('sandbox leak');
       ctx.log('sandbox ok');`,
      bars,
      wasm,
    );
    expect(escapeAttempt.error).toBeUndefined();
    expect(escapeAttempt.logs).toContain('sandbox ok');
  });
});
