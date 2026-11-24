import {
  SessionCalendar,
  type MainOverlayPlot,
  type SubPaneSeriesPlot,
} from '@openview/chart-engine/model';
import type { OHLCVBar, SymbolInfo } from '@openview/protocol';
import type { WasmRuntimeApi } from './wasm-loader.ts';

export interface IndicatorDefinition {
  id: string;
  name: string;
  shortName: string;
  category: 'Moving Averages' | 'Volatility & Channels' | 'Trend' | 'Momentum' | 'Volume';
  placement: 'overlay' | 'subpane';
  description: string;
  requiresVolume?: boolean;
}

export const BUILTIN_INDICATORS: readonly IndicatorDefinition[] = [
  { id: 'ema20', name: 'EMA (20)', shortName: 'EMA 20', category: 'Moving Averages', placement: 'overlay', description: '20-period Exponential Moving Average (SMA-seeded)' },
  { id: 'ema50', name: 'EMA (50)', shortName: 'EMA 50', category: 'Moving Averages', placement: 'overlay', description: '50-period Exponential Moving Average' },
  { id: 'ema200', name: 'EMA (200)', shortName: 'EMA 200', category: 'Moving Averages', placement: 'overlay', description: '200-period Institutional Trend EMA' },
  { id: 'sma20', name: 'SMA (20)', shortName: 'SMA 20', category: 'Moving Averages', placement: 'overlay', description: '20-period Simple Moving Average' },
  { id: 'hma21', name: 'Hull MA (21)', shortName: 'HMA 21', category: 'Moving Averages', placement: 'overlay', description: 'Low-lag Hull Moving Average' },
  { id: 'bb20', name: 'Bollinger Bands (20, 2)', shortName: 'BB 20', category: 'Volatility & Channels', placement: 'overlay', description: 'TradingView-exact population stdev (ddof=0) bands' },
  { id: 'keltner20', name: 'Keltner Channels (20, 2)', shortName: 'KC 20', category: 'Volatility & Channels', placement: 'overlay', description: 'EMA(20) ± 2 × Wilder ATR(20)' },
  { id: 'donchian20', name: 'Donchian Channels (20)', shortName: 'DC 20', category: 'Volatility & Channels', placement: 'overlay', description: '20-bar highest high / lowest low channel' },
  { id: 'supertrend', name: 'SuperTrend (10, 3)', shortName: 'ST 10,3', category: 'Trend', placement: 'overlay', description: 'TradingView-parity ATR trend ratcheting overlay' },
  { id: 'session_vwap', name: 'Session VWAP (±1σ)', shortName: 'VWAP', category: 'Volume', placement: 'overlay', description: 'Exchange session-anchored VWAP (09:15 IST / 09:30 ET / 00:00 UTC)', requiresVolume: true },

  // Sub-pane oscillators
  { id: 'rsi14', name: 'RSI (14)', shortName: 'RSI 14', category: 'Momentum', placement: 'subpane', description: 'Wilder RMA Relative Strength Index (30 / 70)' },
  { id: 'macd', name: 'MACD (12, 26, 9)', shortName: 'MACD', category: 'Momentum', placement: 'subpane', description: 'EMA(12) - EMA(26) with Signal & Histogram' },
  { id: 'stoch14', name: 'Stochastic (14, 3, 3)', shortName: 'STOCH', category: 'Momentum', placement: 'subpane', description: 'Smoothed %K and %D momentum oscillator' },
  { id: 'atr14', name: 'ATR (14)', shortName: 'ATR 14', category: 'Volatility & Channels', placement: 'subpane', description: 'Wilder Average True Range volatility' },
  { id: 'adx14', name: 'ADX / DMI (14)', shortName: 'ADX 14', category: 'Trend', placement: 'subpane', description: 'Wilder +DI, -DI, and ADX trend strength' },
  { id: 'cci20', name: 'CCI (20)', shortName: 'CCI 20', category: 'Momentum', placement: 'subpane', description: 'Commodity Channel Index (-100 / +100)' },
  { id: 'mfi14', name: 'Money Flow Index (14)', shortName: 'MFI 14', category: 'Volume', placement: 'subpane', description: 'Volume-weighted RSI oscillator', requiresVolume: true },
  { id: 'obv', name: 'On-Balance Volume', shortName: 'OBV', category: 'Volume', placement: 'subpane', description: 'Cumulative directional volume flow', requiresVolume: true },
];

export interface ComputedIndicators {
  overlays: MainOverlayPlot[];
  subPanes: Array<{
    paneId: string;
    plots: SubPaneSeriesPlot[];
    fixedRange?: [number, number];
  }>;
  computeMs: number;
}

const sharedCalendar = new SessionCalendar();

export function computeBuiltinIndicators(
  wasm: WasmRuntimeApi,
  activeIds: readonly string[],
  bars: readonly OHLCVBar[],
  symbol: SymbolInfo,
  startBarIndex = 0,
): ComputedIndicators {
  const t0 = performance.now();
  const n = bars.length;
  const overlays: MainOverlayPlot[] = [];
  const subPanes: ComputedIndicators['subPanes'] = [];
  if (n === 0 || activeIds.length === 0) {
    return { overlays, subPanes, computeMs: 0 };
  }

  const high = new Float64Array(n);
  const low = new Float64Array(n);
  const close = new Float64Array(n);
  const volume = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const b = bars[i]!;
    high[i] = b.high;
    low[i] = b.low;
    close[i] = b.close;
    volume[i] = symbol.hasVolume ? b.volume : 0;
  }

  for (const id of activeIds) {
    switch (id) {
      case 'ema20':
        overlays.push({ id, title: 'EMA 20', kind: 'line', color: '#2962ff', startBarIndex, values: wasm.taEma(close, 20) });
        break;
      case 'ema50':
        overlays.push({ id, title: 'EMA 50', kind: 'line', color: '#ff9800', startBarIndex, values: wasm.taEma(close, 50) });
        break;
      case 'ema200':
        overlays.push({ id, title: 'EMA 200', kind: 'line', color: '#e91e63', lineWidth: 2, startBarIndex, values: wasm.taEma(close, 200) });
        break;
      case 'sma20':
        overlays.push({ id, title: 'SMA 20', kind: 'line', color: '#26c6da', startBarIndex, values: wasm.taSma(close, 20) });
        break;
      case 'hma21':
        overlays.push({ id, title: 'HMA 21', kind: 'line', color: '#ab47bc', lineWidth: 2, startBarIndex, values: wasm.taHma(close, 21) });
        break;
      case 'bb20': {
        const flat = wasm.taBollingerBands(close, 20, 2);
        overlays.push({
          id,
          title: 'BB (20, 2)',
          kind: 'band_fill',
          color: '#2962ff',
          startBarIndex,
          values: flat.subarray(0, n),
          extraValues: flat.subarray(n, 2 * n),
          lowerValues: flat.subarray(2 * n, 3 * n),
        });
        break;
      }
      case 'keltner20': {
        const flat = wasm.taKeltnerChannels(high, low, close, 20, 2);
        overlays.push({
          id,
          title: 'KC (20, 2)',
          kind: 'band_fill',
          color: '#26a69a',
          startBarIndex,
          values: flat.subarray(0, n),
          extraValues: flat.subarray(n, 2 * n),
          lowerValues: flat.subarray(2 * n, 3 * n),
        });
        break;
      }
      case 'donchian20': {
        const flat = wasm.taDonchianChannels(high, low, 20);
        overlays.push({
          id,
          title: 'DC (20)',
          kind: 'band_fill',
          color: '#7e57c2',
          startBarIndex,
          values: flat.subarray(0, n),
          extraValues: flat.subarray(n, 2 * n),
          lowerValues: flat.subarray(2 * n, 3 * n),
        });
        break;
      }
      case 'supertrend': {
        const flat = wasm.taSupertrend(high, low, close, 10, 3);
        overlays.push({
          id,
          title: 'SuperTrend (10, 3)',
          kind: 'supertrend',
          color: '#089981',
          lineWidth: 2,
          startBarIndex,
          values: flat.subarray(0, n),
          extraValues: flat.subarray(n, 2 * n),
        });
        break;
      }
      case 'session_vwap': {
        const breaks = new Uint8Array(n);
        breaks[0] = 1;
        for (let i = 1; i < n; i++) {
          if (sharedCalendar.isSessionBreak(bars[i - 1]!.time, bars[i]!.time, symbol.calendarId)) {
            breaks[i] = 1;
          }
        }
        const flat = wasm.taSessionVwap(high, low, close, volume, breaks);
        overlays.push({
          id,
          title: 'Session VWAP',
          kind: 'band_fill',
          color: '#f7931a',
          lineWidth: 2,
          startBarIndex,
          values: flat.subarray(0, n),
          extraValues: flat.subarray(n, 2 * n),
          lowerValues: flat.subarray(2 * n, 3 * n),
        });
        break;
      }
      case 'rsi14':
        subPanes.push({
          paneId: 'rsi14',
          fixedRange: [0, 100],
          plots: [
            { id: 'rsi14', title: 'RSI (14)', color: '#7e57c2', kind: 'line', startBarIndex, values: wasm.taRsi(close, 14), refLines: [30, 70] },
          ],
        });
        break;
      case 'macd': {
        const flat = wasm.taMacd(close, 12, 26, 9);
        subPanes.push({
          paneId: 'macd',
          plots: [
            { id: 'macd_hist', title: 'MACD Hist', color: '#089981', kind: 'histogram', startBarIndex, values: flat.subarray(2 * n, 3 * n), refLines: [0] },
            { id: 'macd_line', title: 'MACD', color: '#2962ff', kind: 'line', startBarIndex, values: flat.subarray(0, n) },
            { id: 'macd_sig', title: 'Signal', color: '#ff9800', kind: 'line', startBarIndex, values: flat.subarray(n, 2 * n) },
          ],
        });
        break;
      }
      case 'stoch14': {
        const flat = wasm.taStochastic(high, low, close, 14, 3, 3);
        subPanes.push({
          paneId: 'stoch14',
          fixedRange: [0, 100],
          plots: [
            { id: 'stoch_k', title: '%K', color: '#2962ff', kind: 'line', startBarIndex, values: flat.subarray(0, n), refLines: [20, 80] },
            { id: 'stoch_d', title: '%D', color: '#ff9800', kind: 'line', startBarIndex, values: flat.subarray(n, 2 * n) },
          ],
        });
        break;
      }
      case 'atr14':
        subPanes.push({
          paneId: 'atr14',
          plots: [{ id: 'atr14', title: 'ATR (14)', color: '#f23645', kind: 'line', startBarIndex, values: wasm.taAtr(high, low, close, 14) }],
        });
        break;
      case 'adx14': {
        const flat = wasm.taAdxDmi(high, low, close, 14);
        subPanes.push({
          paneId: 'adx14',
          fixedRange: [0, 75],
          plots: [
            { id: 'adx_pdi', title: '+DI', color: '#089981', kind: 'line', startBarIndex, values: flat.subarray(0, n), refLines: [25] },
            { id: 'adx_mdi', title: '-DI', color: '#f23645', kind: 'line', startBarIndex, values: flat.subarray(n, 2 * n) },
            { id: 'adx_val', title: 'ADX', color: '#f7931a', kind: 'line', startBarIndex, values: flat.subarray(2 * n, 3 * n) },
          ],
        });
        break;
      }
      case 'cci20':
        subPanes.push({
          paneId: 'cci20',
          plots: [{ id: 'cci20', title: 'CCI (20)', color: '#26c6da', kind: 'line', startBarIndex, values: wasm.taCci(high, low, close, 20), refLines: [-100, 100] }],
        });
        break;
      case 'mfi14':
        subPanes.push({
          paneId: 'mfi14',
          fixedRange: [0, 100],
          plots: [{ id: 'mfi14', title: 'MFI (14)', color: '#ab47bc', kind: 'line', startBarIndex, values: wasm.taMfi(high, low, close, volume, 14), refLines: [20, 80] }],
        });
        break;
      case 'obv':
        subPanes.push({
          paneId: 'obv',
          plots: [{ id: 'obv', title: 'OBV', color: '#2962ff', kind: 'line', startBarIndex, values: wasm.taObv(close, volume) }],
        });
        break;
    }
  }

  return {
    overlays,
    subPanes,
    computeMs: Number((performance.now() - t0).toFixed(2)),
  };
}
