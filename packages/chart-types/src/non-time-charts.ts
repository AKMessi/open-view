import type { OHLCVBar } from '@openview/protocol';

export type NonTimeChartMode =
  | 'standard'
  | 'renko'
  | 'range'
  | 'kagi'
  | 'point_and_figure'
  | 'line_break';

export interface NonTimeBar extends OHLCVBar {
  /** Extra metadata for specialized rendering (Kagi Yang/Yin, P&F X/O) */
  meta?: {
    kind: 'renko' | 'range' | 'kagi' | 'pnf' | 'line_break';
    trend?: 'yang' | 'yin' | 'X' | 'O';
    boxes?: number;
  };
}

export interface RenkoOptions {
  mode?: 'fixed' | 'atr';
  brickSize?: number;
  atrPeriod?: number;
}

export function isSyntheticPriceChart(
  chartMode: NonTimeChartMode,
  chartStyle: string,
): boolean {
  return chartMode !== 'standard' || chartStyle === 'heikin_ashi';
}

function computeAutoBrickSize(bars: readonly OHLCVBar[], period = 14): number {
  if (bars.length === 0) return 1;
  if (bars.length < 2) return Math.max(1e-6, bars[0]!.close * 0.005);
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prevC = bars[i - 1]!.close;
    const b = bars[i]!;
    trs.push(Math.max(b.high - b.low, Math.abs(b.high - prevC), Math.abs(b.low - prevC)));
  }
  const n = Math.min(period, trs.length);
  let atr = 0;
  for (let i = 0; i < n; i++) atr += trs[i]!;
  atr /= n;
  for (let i = n; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]!) / period;
  }
  return Math.max(1e-6, Number(atr.toPrecision(4)));
}

/**
 * 1m-Sourced Renko Generator:
 * Emits multiple bricks with identical `time` when a volatile source bar crosses multiple brick levels
 * (preserved natively by MipmapPlotList integer barIndex keys) and conserves total volume.
 */
export function buildRenkoBars(
  sourceBars: readonly OHLCVBar[],
  options: RenkoOptions = {},
): NonTimeBar[] {
  if (sourceBars.length === 0) return [];
  const brick =
    options.mode === 'fixed' && options.brickSize && options.brickSize > 0
      ? options.brickSize
      : computeAutoBrickSize(sourceBars, options.atrPeriod ?? 14);

  const out: NonTimeBar[] = [];
  let refPrice = Math.round(sourceBars[0]!.close / brick) * brick;
  let lastDir: 1 | -1 | 0 = 0;
  let accVol = 0;

  for (const bar of sourceBars) {
    accVol += bar.volume;
    // Check intra-bar high/low path based on candle polarity for realistic brick sequence
    const checkpoints =
      bar.close >= bar.open ? [bar.low, bar.high, bar.close] : [bar.high, bar.low, bar.close];

    const emittedThisBar: NonTimeBar[] = [];
    for (const px of checkpoints) {
      let guard = 0;
      while (guard++ < 500) {
        const upThreshold = lastDir === -1 ? refPrice + 2 * brick : refPrice + brick;
        const downThreshold = lastDir === 1 ? refPrice - 2 * brick : refPrice - brick;

        if (px >= upThreshold) {
          const open = lastDir === -1 ? refPrice + brick : refPrice;
          const close = open + brick;
          emittedThisBar.push({
            time: bar.time,
            open,
            high: close,
            low: open,
            close,
            volume: 0,
            meta: { kind: 'renko' },
          });
          refPrice = close;
          lastDir = 1;
        } else if (px <= downThreshold) {
          const open = lastDir === 1 ? refPrice - brick : refPrice;
          const close = open - brick;
          emittedThisBar.push({
            time: bar.time,
            open,
            high: open,
            low: close,
            close,
            volume: 0,
            meta: { kind: 'renko' },
          });
          refPrice = close;
          lastDir = -1;
        } else {
          break;
        }
      }
    }

    if (emittedThisBar.length > 0) {
      const volPerBrick = accVol / emittedThisBar.length;
      for (const b of emittedThisBar) {
        b.volume = volPerBrick;
        out.push(b);
      }
      accVol = 0;
    }
  }

  return out;
}

/**
 * 1m-Sourced Constant Range Bars:
 * Every completed bar satisfies `high - low === rangeSize`.
 */
export function buildRangeBars(
  sourceBars: readonly OHLCVBar[],
  rangeSize?: number,
): NonTimeBar[] {
  if (sourceBars.length === 0) return [];
  const step = rangeSize && rangeSize > 0 ? rangeSize : computeAutoBrickSize(sourceBars, 14);
  const out: NonTimeBar[] = [];

  let curOpen = sourceBars[0]!.open;
  let curHigh = curOpen;
  let curLow = curOpen;
  let curVol = 0;

  for (const bar of sourceBars) {
    const seq = bar.close >= bar.open ? [bar.open, bar.low, bar.high, bar.close] : [bar.open, bar.high, bar.low, bar.close];
    const volSlice = bar.volume / seq.length;

    for (const target of seq) {
      curVol += volSlice;
      let guard = 0;
      while (guard++ < 500) {
        const nextHigh = Math.max(curHigh, target);
        const nextLow = Math.min(curLow, target);
        if (nextHigh - nextLow < step) {
          curHigh = nextHigh;
          curLow = nextLow;
          break;
        }
        // Close bar in direction of move
        if (target >= curHigh && curLow + step <= target) {
          const close = curLow + step;
          out.push({
            time: bar.time,
            open: curOpen,
            high: close,
            low: curLow,
            close,
            volume: curVol,
            meta: { kind: 'range' },
          });
          curOpen = close;
          curHigh = close;
          curLow = close;
          curVol = 0;
        } else if (target <= curLow && curHigh - step >= target) {
          const close = curHigh - step;
          out.push({
            time: bar.time,
            open: curOpen,
            high: curHigh,
            low: close,
            close,
            volume: curVol,
            meta: { kind: 'range' },
          });
          curOpen = close;
          curHigh = close;
          curLow = close;
          curVol = 0;
        } else {
          break;
        }
      }
    }
  }

  // Include active forming bar
  const lastSrc = sourceBars[sourceBars.length - 1]!;
  if (out.length === 0 || curVol > 0) {
    out.push({
      time: lastSrc.time,
      open: curOpen,
      high: Math.max(curHigh, lastSrc.close),
      low: Math.min(curLow, lastSrc.close),
      close: lastSrc.close,
      volume: curVol,
      meta: { kind: 'range' },
    });
  }

  return out;
}

/**
 * Kagi Chart Builder (Yang / Yin shoulder-waist breakout logic).
 */
export function buildKagiBars(
  sourceBars: readonly OHLCVBar[],
  reversalAmount?: number,
): NonTimeBar[] {
  if (sourceBars.length === 0) return [];
  const rev = reversalAmount && reversalAmount > 0 ? reversalAmount : computeAutoBrickSize(sourceBars, 14) * 2;

  const out: NonTimeBar[] = [];
  let startPrice = sourceBars[0]!.close;
  let extreme = startPrice;
  let dir: 1 | -1 | 0 = 0;
  let prevShoulder = startPrice;
  let prevWaist = startPrice;
  let trend: 'yang' | 'yin' = 'yang';
  let accVol = 0;

  for (const bar of sourceBars) {
    const p = bar.close;
    accVol += bar.volume;
    if (dir === 0) {
      if (p >= startPrice + rev) {
        dir = 1;
        extreme = p;
        trend = 'yang';
      } else if (p <= startPrice - rev) {
        dir = -1;
        extreme = p;
        trend = 'yin';
      }
      continue;
    }

    if (dir === 1) {
      if (p > extreme) {
        extreme = p;
        if (extreme > prevShoulder) trend = 'yang';
      } else if (p <= extreme - rev) {
        out.push({
          time: bar.time,
          open: startPrice,
          high: Math.max(startPrice, extreme),
          low: Math.min(startPrice, extreme),
          close: extreme,
          volume: accVol,
          meta: { kind: 'kagi', trend },
        });
        prevShoulder = extreme;
        startPrice = extreme;
        extreme = p;
        dir = -1;
        accVol = 0;
        if (extreme < prevWaist) trend = 'yin';
      }
    } else {
      if (p < extreme) {
        extreme = p;
        if (extreme < prevWaist) trend = 'yin';
      } else if (p >= extreme + rev) {
        out.push({
          time: bar.time,
          open: startPrice,
          high: Math.max(startPrice, extreme),
          low: Math.min(startPrice, extreme),
          close: extreme,
          volume: accVol,
          meta: { kind: 'kagi', trend },
        });
        prevWaist = extreme;
        startPrice = extreme;
        extreme = p;
        dir = 1;
        accVol = 0;
        if (extreme > prevShoulder) trend = 'yang';
      }
    }
  }

  const last = sourceBars[sourceBars.length - 1]!;
  if (dir !== 0) {
    out.push({
      time: last.time,
      open: startPrice,
      high: Math.max(startPrice, extreme),
      low: Math.min(startPrice, extreme),
      close: extreme,
      volume: accVol,
      meta: { kind: 'kagi', trend },
    });
  }
  return out;
}

/**
 * Point & Figure (X / O Column Generator, default 3-box reversal).
 */
export function buildPointAndFigureBars(
  sourceBars: readonly OHLCVBar[],
  boxSize?: number,
  reversalBoxes = 3,
): NonTimeBar[] {
  if (sourceBars.length === 0) return [];
  const box = boxSize && boxSize > 0 ? boxSize : computeAutoBrickSize(sourceBars, 14);
  const rev = box * Math.max(1, reversalBoxes);

  const out: NonTimeBar[] = [];
  let colStart = Math.round(sourceBars[0]!.close / box) * box;
  let colExtreme = colStart;
  let colType: 'X' | 'O' | null = null;
  let accVol = 0;

  for (const bar of sourceBars) {
    accVol += bar.volume;
    if (!colType) {
      if (bar.high >= colStart + box) {
        colType = 'X';
        colExtreme = Math.floor(bar.high / box) * box;
      } else if (bar.low <= colStart - box) {
        colType = 'O';
        colExtreme = Math.ceil(bar.low / box) * box;
      }
      continue;
    }

    if (colType === 'X') {
      const nextTop = Math.floor(bar.high / box) * box;
      if (nextTop > colExtreme) {
        colExtreme = nextTop;
      } else if (bar.low <= colExtreme - rev) {
        const boxes = Math.max(1, Math.round(Math.abs(colExtreme - colStart) / box));
        out.push({
          time: bar.time,
          open: colStart,
          high: colExtreme,
          low: colStart,
          close: colExtreme,
          volume: accVol,
          meta: { kind: 'pnf', trend: 'X', boxes },
        });
        colStart = colExtreme - box;
        colExtreme = Math.ceil(bar.low / box) * box;
        colType = 'O';
        accVol = 0;
      }
    } else {
      const nextBot = Math.ceil(bar.low / box) * box;
      if (nextBot < colExtreme) {
        colExtreme = nextBot;
      } else if (bar.high >= colExtreme + rev) {
        const boxes = Math.max(1, Math.round(Math.abs(colExtreme - colStart) / box));
        out.push({
          time: bar.time,
          open: colStart,
          high: colStart,
          low: colExtreme,
          close: colExtreme,
          volume: accVol,
          meta: { kind: 'pnf', trend: 'O', boxes },
        });
        colStart = colExtreme + box;
        colExtreme = Math.floor(bar.high / box) * box;
        colType = 'X';
        accVol = 0;
      }
    }
  }

  if (colType) {
    const last = sourceBars[sourceBars.length - 1]!;
    const boxes = Math.max(1, Math.round(Math.abs(colExtreme - colStart) / box));
    out.push({
      time: last.time,
      open: colStart,
      high: Math.max(colStart, colExtreme),
      low: Math.min(colStart, colExtreme),
      close: colExtreme,
      volume: accVol,
      meta: { kind: 'pnf', trend: colType, boxes },
    });
  }
  return out;
}

/**
 * Line Break Chart Builder (default 3-Line Break).
 */
export function buildLineBreakBars(
  sourceBars: readonly OHLCVBar[],
  lineCount = 3,
): NonTimeBar[] {
  if (sourceBars.length < 2) return [];
  const k = Math.max(1, Math.floor(lineCount));
  const out: NonTimeBar[] = [];

  const first = sourceBars[0]!;
  let prevOpen = first.open;
  let prevClose = first.close;
  out.push({
    time: first.time,
    open: prevOpen,
    high: Math.max(prevOpen, prevClose),
    low: Math.min(prevOpen, prevClose),
    close: prevClose,
    volume: first.volume,
    meta: { kind: 'line_break' },
  });

  for (let i = 1; i < sourceBars.length; i++) {
    const b = sourceBars[i]!;
    const lastLine = out[out.length - 1]!;
    const isBull = lastLine.close >= lastLine.open;
    const recent = out.slice(-k);
    const recentMax = Math.max(...recent.map((r) => Math.max(r.open, r.close)));
    const recentMin = Math.min(...recent.map((r) => Math.min(r.open, r.close)));

    if (isBull) {
      if (b.close > lastLine.close) {
        out.push({
          time: b.time,
          open: lastLine.close,
          high: b.close,
          low: lastLine.close,
          close: b.close,
          volume: b.volume,
          meta: { kind: 'line_break' },
        });
      } else if (b.close < recentMin) {
        out.push({
          time: b.time,
          open: lastLine.open,
          high: lastLine.open,
          low: b.close,
          close: b.close,
          volume: b.volume,
          meta: { kind: 'line_break' },
        });
      }
    } else {
      if (b.close < lastLine.close) {
        out.push({
          time: b.time,
          open: lastLine.close,
          high: lastLine.close,
          low: b.close,
          close: b.close,
          volume: b.volume,
          meta: { kind: 'line_break' },
        });
      } else if (b.close > recentMax) {
        out.push({
          time: b.time,
          open: lastLine.open,
          high: b.close,
          low: lastLine.open,
          close: b.close,
          volume: b.volume,
          meta: { kind: 'line_break' },
        });
      }
    }
  }

  return out;
}

export function transformNonTimeBars(
  sourceBars: readonly OHLCVBar[],
  mode: NonTimeChartMode,
  param?: number,
): NonTimeBar[] {
  switch (mode) {
    case 'renko':
      return buildRenkoBars(sourceBars, param ? { mode: 'fixed', brickSize: param } : { mode: 'atr' });
    case 'range':
      return buildRangeBars(sourceBars, param);
    case 'kagi':
      return buildKagiBars(sourceBars, param);
    case 'point_and_figure':
      return buildPointAndFigureBars(sourceBars, param, 3);
    case 'line_break':
      return buildLineBreakBars(sourceBars, param ?? 3);
    default:
      return sourceBars.map((b) => ({ ...b }));
  }
}
