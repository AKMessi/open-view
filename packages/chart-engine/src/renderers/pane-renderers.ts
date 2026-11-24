import type { ChartStyle, Resolution, SymbolInfo } from '@openview/protocol';
import {
  computeCandleBitmapMetrics,
  snapHairline,
  type CanvasMetrics,
  type Rect,
  type TileLayout,
} from '../canvas/tile-canvas-pair.ts';
import type { MipmapPlotList, PlotBarView } from '../model/mipmap-plot-list.ts';
import type { SymlogPriceScale } from '../model/price-scale.ts';
import { getLocalParts, type SessionCalendar } from '../model/session-calendar.ts';
import type { TimeScale } from '../model/time-scale.ts';
import type { ChartTheme } from './theme.ts';

export interface CrosshairState {
  visible: boolean;
  x: number;
  y: number;
  paneId: string;
  barIndex: number | null;
  price: number | null;
}

export interface SubPaneSeriesPlot {
  id: string;
  title: string;
  color: string;
  kind: 'line' | 'histogram';
  /** Aligned to barIndex starting at startBarIndex */
  startBarIndex: number;
  values: Float64Array;
  refLines?: number[];
}

export interface BaseRenderInput {
  ctx: CanvasRenderingContext2D;
  metrics: CanvasMetrics;
  layout: TileLayout;
  theme: ChartTheme;
  symbol: SymbolInfo;
  resolution: Resolution;
  chartStyle: ChartStyle;
  showVolume: boolean;
  showSessionBreaks: boolean;
  plotList: MipmapPlotList;
  timeScale: TimeScale;
  mainPriceScale: SymlogPriceScale;
  calendar: SessionCalendar;
  subPanes: Map<string, { priceScale: SymlogPriceScale; plots: SubPaneSeriesPlot[] }>;
}

export interface TopRenderInput {
  ctx: CanvasRenderingContext2D;
  metrics: CanvasMetrics;
  layout: TileLayout;
  theme: ChartTheme;
  symbol: SymbolInfo;
  resolution: Resolution;
  plotList: MipmapPlotList;
  timeScale: TimeScale;
  mainPriceScale: SymlogPriceScale;
  subPanes: Map<string, { priceScale: SymlogPriceScale; plots: SubPaneSeriesPlot[] }>;
  crosshair: CrosshairState;
  hoveredDividerIndex: number | null;
}

function clipRectBitmap(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  rx: number,
  ry: number,
): void {
  ctx.beginPath();
  ctx.rect(
    Math.floor(rect.x * rx),
    Math.floor(rect.y * ry),
    Math.ceil(rect.width * rx),
    Math.ceil(rect.height * ry),
  );
  ctx.clip();
}

export function renderBaseLayer(input: BaseRenderInput): { drawnBars: number; mipmapStride: number } {
  const {
    ctx,
    metrics,
    layout,
    theme,
    symbol,
    resolution,
    chartStyle,
    showVolume,
    showSessionBreaks,
    plotList,
    timeScale,
    mainPriceScale,
    calendar,
    subPanes,
  } = input;

  const rx = metrics.horizontalPixelRatio;
  const ry = metrics.verticalPixelRatio;

  // 1. Clear full bitmap background
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, metrics.bitmapWidth, metrics.bitmapHeight);

  const mainPane = layout.panes[0];
  if (!mainPane) {
    ctx.restore();
    return { drawnBars: 0, mipmapStride: 1 };
  }

  const vis = plotList.length > 0
    ? timeScale.getVisibleLogicalRange(plotList.firstIndex(), plotList.lastIndex())
    : { from: 0, to: -1, rawFrom: 0, rawTo: 0 };

  const timeTicks = plotList.length > 0
    ? timeScale.buildTickMarks(
        vis.from,
        vis.to,
        (idx) => plotList.getBar(idx)?.time ?? null,
        symbol.timezone,
      )
    : [];

  // 2. Render Main Pane (Grid + Watermark + Session Breaks + Volume + Series)
  ctx.save();
  clipRectBitmap(ctx, mainPane.rect, rx, ry);

  const priceTicks = mainPriceScale.buildTickMarks(38);

  // Grid lines (physical hairline snapped)
  ctx.strokeStyle = theme.gridLine;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const pt of priceTicks) {
    const py = snapHairline(pt.y, ry, 1);
    ctx.moveTo(0, py);
    ctx.lineTo(Math.ceil(mainPane.rect.width * rx), py);
  }
  for (const tt of timeTicks) {
    const px = snapHairline(tt.x, rx, 1);
    ctx.moveTo(px, Math.floor(mainPane.rect.y * ry));
    ctx.lineTo(px, Math.ceil((mainPane.rect.y + mainPane.rect.height) * ry));
  }
  ctx.stroke();

  // Watermark
  ctx.save();
  ctx.setTransform(rx, 0, 0, ry, 0, 0);
  ctx.fillStyle = theme.watermark;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${Math.min(54, Math.max(24, Math.floor(mainPane.rect.width * 0.055)))}px ${theme.fontFamily}`;
  ctx.fillText(
    `${symbol.ticker} · ${resolution}`,
    mainPane.rect.x + mainPane.rect.width * 0.5,
    mainPane.rect.y + mainPane.rect.height * 0.48,
  );
  ctx.restore();

  let drawnBars = 0;
  let mipmapStride = 1;

  if (plotList.length > 0 && vis.from <= vis.to) {
    const useHA = chartStyle === 'heikin_ashi';
    const bounds = plotList.getPriceBounds(vis.from, vis.to, timeScale.barSpacing, useHA);
    const maxVol = bounds?.maxVolume ?? 0;

    // Optional session break vertical dashed lines (only when zoomed in enough)
    if (showSessionBreaks && timeScale.barSpacing >= 2.5 && symbol.calendarId !== 'CRYPTO') {
      ctx.save();
      ctx.strokeStyle = theme.sessionBreakLine;
      ctx.lineWidth = 1;
      ctx.setLineDash([4 * ry, 4 * ry]);
      ctx.beginPath();
      let prevTime: number | null = null;
      for (let idx = vis.from; idx <= vis.to; idx++) {
        const b = plotList.getBar(idx);
        if (!b) continue;
        if (prevTime !== null && calendar.isSessionBreak(prevTime, b.time, symbol.calendarId)) {
          const px = snapHairline(timeScale.indexToCoordinate(idx), rx, 1);
          ctx.moveTo(px, Math.floor(mainPane.rect.y * ry));
          ctx.lineTo(px, Math.ceil((mainPane.rect.y + mainPane.rect.height) * ry));
        }
        prevTime = b.time;
      }
      ctx.stroke();
      ctx.restore();
    }

    // Volume histogram overlay (bottom 18% of main pane; auto-hidden when symbol.hasVolume === false)
    if (showVolume && symbol.hasVolume && maxVol > 0) {
      const volBottomPx = Math.floor((mainPane.rect.y + mainPane.rect.height) * ry);
      const volMaxHeightPx = Math.max(12, Math.floor(mainPane.rect.height * 0.18 * ry));
      plotList.forEachVisible(vis.from, vis.to, timeScale.barSpacing, false, (idx, endIdx, _t, o, _h, _l, c, v) => {
        if (v <= 0) return;
        const midIdx = (idx + endIdx) * 0.5;
        const centerX = timeScale.indexToCoordinate(midIdx);
        const spanSpacing = timeScale.barSpacing * (endIdx - idx + 1);
        const geom = computeCandleBitmapMetrics(centerX, spanSpacing, rx);
        const hPx = Math.max(1, Math.round((v / maxVol) * volMaxHeightPx));
        ctx.fillStyle = c >= o ? theme.volUp : theme.volDown;
        ctx.fillRect(geom.bodyLeftPx, volBottomPx - hPx, geom.bodyWidthPx, hPx);
      });
    }

    // Main Price Series
    const res = drawPriceSeries(
      ctx,
      plotList,
      vis.from,
      vis.to,
      timeScale,
      mainPriceScale,
      mainPane.rect,
      rx,
      ry,
      chartStyle,
      theme,
    );
    drawnBars = res.drawnCount;
    mipmapStride = res.levelStride;

    // Live Last-Price Dashed Horizontal Line
    const lastBar = plotList.getLastBar();
    if (lastBar) {
      const ly = snapHairline(mainPriceScale.priceToCoordinate(lastBar.close), ry, 1);
      ctx.save();
      ctx.strokeStyle = lastBar.close >= lastBar.open ? theme.upCandle : theme.downCandle;
      ctx.lineWidth = 1;
      ctx.setLineDash([3 * rx, 3 * rx]);
      ctx.beginPath();
      ctx.moveTo(0, ly);
      ctx.lineTo(Math.ceil(mainPane.rect.width * rx), ly);
      ctx.stroke();
      ctx.restore();
    }
  }
  ctx.restore(); // End main pane clip

  // 3. Render Main Price Axis Gutter
  renderPriceAxisGutter(ctx, mainPane.priceAxisRect, priceTicks, mainPriceScale, plotList.getLastBar(), rx, ry, theme);

  // 4. Render Stacked Sub-Panes (e.g. RSI / MACD / Custom Indicator Panes)
  for (let pi = 1; pi < layout.panes.length; pi++) {
    const paneLayout = layout.panes[pi]!;
    const sub = subPanes.get(paneLayout.id);
    if (!sub) continue;

    ctx.save();
    clipRectBitmap(ctx, paneLayout.rect, rx, ry);

    const subTicks = sub.priceScale.buildTickMarks(32);
    ctx.strokeStyle = theme.gridLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const pt of subTicks) {
      const py = snapHairline(pt.y, ry, 1);
      ctx.moveTo(0, py);
      ctx.lineTo(Math.ceil(paneLayout.rect.width * rx), py);
    }
    ctx.stroke();

    for (const plot of sub.plots) {
      if (plot.refLines) {
        ctx.save();
        ctx.strokeStyle = theme.sessionBreakLine;
        ctx.setLineDash([3 * rx, 3 * rx]);
        ctx.beginPath();
        for (const level of plot.refLines) {
          const py = snapHairline(sub.priceScale.priceToCoordinate(level), ry, 1);
          ctx.moveTo(0, py);
          ctx.lineTo(Math.ceil(paneLayout.rect.width * rx), py);
        }
        ctx.stroke();
        ctx.restore();
      }

      if (plot.kind === 'line') {
        ctx.strokeStyle = plot.color;
        ctx.lineWidth = Math.max(1, Math.round(1.5 * ry));
        ctx.beginPath();
        let started = false;
        const start = Math.max(vis.from, plot.startBarIndex);
        const end = Math.min(vis.to, plot.startBarIndex + plot.values.length - 1);
        for (let idx = start; idx <= end; idx++) {
          const v = plot.values[idx - plot.startBarIndex]!;
          if (Number.isNaN(v)) {
            started = false;
            continue;
          }
          const px = timeScale.indexToCoordinate(idx) * rx;
          const py = sub.priceScale.priceToCoordinate(v) * ry;
          if (!started) {
            ctx.moveTo(px, py);
            started = true;
          } else {
            ctx.lineTo(px, py);
          }
        }
        ctx.stroke();
      }
    }
    ctx.restore();

    renderPriceAxisGutter(ctx, paneLayout.priceAxisRect, subTicks, sub.priceScale, null, rx, ry, theme);
  }

  // 5. Render Pane Dividers & Axis Borders
  ctx.strokeStyle = theme.paneDivider;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const div of layout.dividers) {
    const dy = snapHairline(div.y, ry, 1);
    ctx.moveTo(0, dy);
    ctx.lineTo(metrics.bitmapWidth, dy);
  }
  ctx.stroke();

  ctx.strokeStyle = theme.axisBorder;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const axisX = snapHairline(layout.plotWidth, rx, 1);
  ctx.moveTo(axisX, 0);
  ctx.lineTo(axisX, metrics.bitmapHeight);
  const timeY = snapHairline(layout.plotHeight, ry, 1);
  ctx.moveTo(0, timeY);
  ctx.lineTo(metrics.bitmapWidth, timeY);
  ctx.stroke();

  // 6. Render Bottom Time Axis Labels
  ctx.save();
  clipRectBitmap(ctx, layout.timeAxisRect, rx, ry);
  ctx.setTransform(rx, 0, 0, ry, 0, 0);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const labelY = layout.timeAxisRect.y + layout.timeAxisRect.height * 0.54;
  for (const tt of timeTicks) {
    ctx.fillStyle = tt.bold ? theme.axisTextBold : theme.axisText;
    ctx.font = `${tt.bold ? '600' : '400'} 11px ${theme.monoFontFamily}`;
    ctx.fillText(tt.label, tt.x, labelY);
  }
  ctx.restore();

  ctx.restore();
  return { drawnBars, mipmapStride };
}

function drawPriceSeries(
  ctx: CanvasRenderingContext2D,
  plotList: MipmapPlotList,
  fromIdx: number,
  toIdx: number,
  timeScale: TimeScale,
  priceScale: SymlogPriceScale,
  paneRect: Rect,
  rx: number,
  ry: number,
  style: ChartStyle,
  theme: ChartTheme,
): { levelStride: number; drawnCount: number } {
  const useHA = style === 'heikin_ashi';

  if (style === 'line' || style === 'step_line' || style === 'area' || style === 'baseline') {
    const points: Array<{ px: number; py: number }> = [];
    const res = plotList.forEachVisible(fromIdx, toIdx, timeScale.barSpacing, false, (idx, endIdx, _t, _o, _h, _l, c) => {
      const px = timeScale.indexToCoordinate((idx + endIdx) * 0.5) * rx;
      const py = priceScale.priceToCoordinate(c) * ry;
      points.push({ px, py });
    });
    if (points.length === 0) return res;

    if (style === 'area') {
      const bottomPx = (paneRect.y + paneRect.height) * ry;
      const grad = ctx.createLinearGradient(0, paneRect.y * ry, 0, bottomPx);
      grad.addColorStop(0, theme.areaTop);
      grad.addColorStop(1, theme.areaBottom);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(points[0]!.px, bottomPx);
      for (const p of points) ctx.lineTo(p.px, p.py);
      ctx.lineTo(points[points.length - 1]!.px, bottomPx);
      ctx.closePath();
      ctx.fill();
    }

    if (style === 'baseline') {
      const midPrice = (priceScale.minValue + priceScale.maxValue) * 0.5;
      const basePx = priceScale.priceToCoordinate(midPrice) * ry;
      ctx.strokeStyle = theme.sessionBreakLine;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, snapHairline(basePx / ry, ry, 1));
      ctx.lineTo(paneRect.width * rx, snapHairline(basePx / ry, ry, 1));
      ctx.stroke();

      // Top green clip
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, paneRect.y * ry, paneRect.width * rx, Math.max(0, basePx - paneRect.y * ry));
      ctx.clip();
      ctx.strokeStyle = theme.upCandle;
      ctx.lineWidth = Math.max(1.5, Math.round(1.75 * ry));
      ctx.beginPath();
      for (let i = 0; i < points.length; i++) {
        if (i === 0) ctx.moveTo(points[i]!.px, points[i]!.py);
        else ctx.lineTo(points[i]!.px, points[i]!.py);
      }
      ctx.stroke();
      ctx.restore();

      // Bottom red clip
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, basePx, paneRect.width * rx, Math.max(0, (paneRect.y + paneRect.height) * ry - basePx));
      ctx.clip();
      ctx.strokeStyle = theme.downCandle;
      ctx.lineWidth = Math.max(1.5, Math.round(1.75 * ry));
      ctx.beginPath();
      for (let i = 0; i < points.length; i++) {
        if (i === 0) ctx.moveTo(points[i]!.px, points[i]!.py);
        else ctx.lineTo(points[i]!.px, points[i]!.py);
      }
      ctx.stroke();
      ctx.restore();
      return res;
    }

    ctx.strokeStyle = theme.lineColor;
    ctx.lineWidth = Math.max(1.5, Math.round(1.75 * ry));
    ctx.beginPath();
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!;
      if (i === 0) {
        ctx.moveTo(p.px, p.py);
      } else if (style === 'step_line') {
        ctx.lineTo(p.px, points[i - 1]!.py);
        ctx.lineTo(p.px, p.py);
      } else {
        ctx.lineTo(p.px, p.py);
      }
    }
    ctx.stroke();
    return res;
  }

  // Candlesticks, Hollow Candles, Heikin Ashi, OHLC Bars
  return plotList.forEachVisible(fromIdx, toIdx, timeScale.barSpacing, useHA, (idx, endIdx, _t, o, h, l, c) => {
    const isUp = c >= o;
    const midIdx = (idx + endIdx) * 0.5;
    const centerCssX = timeScale.indexToCoordinate(midIdx);
    const effectiveSpacing = timeScale.barSpacing * (endIdx - idx + 1);
    const geom = computeCandleBitmapMetrics(centerCssX, effectiveSpacing, rx);

    const highPx = Math.round(priceScale.priceToCoordinate(h) * ry);
    const lowPx = Math.round(priceScale.priceToCoordinate(l) * ry);
    const openPx = Math.round(priceScale.priceToCoordinate(o) * ry);
    const closePx = Math.round(priceScale.priceToCoordinate(c) * ry);

    const topBodyPx = Math.min(openPx, closePx);
    const botBodyPx = Math.max(openPx, closePx);
    const bodyHeightPx = Math.max(1, botBodyPx - topBodyPx);

    if (style === 'bars') {
      const color = isUp ? theme.upCandle : theme.downCandle;
      ctx.fillStyle = color;
      const wickLeft = Math.floor(geom.wickCenterPx - geom.wickWidthPx / 2);
      ctx.fillRect(wickLeft, highPx, geom.wickWidthPx, Math.max(1, lowPx - highPx));
      const tickHalf = Math.max(1, Math.floor(geom.bodyWidthPx / 2));
      const strokeH = Math.max(1, Math.round(ry));
      ctx.fillRect(wickLeft - tickHalf, openPx, tickHalf + geom.wickWidthPx, strokeH);
      ctx.fillRect(wickLeft, closePx, tickHalf + geom.wickWidthPx, strokeH);
      return;
    }

    const wickLeft = Math.floor(geom.wickCenterPx - geom.wickWidthPx / 2);
    const color = isUp ? theme.upCandle : theme.downCandle;

    if (style === 'hollow_candles' && isUp && geom.bodyWidthPx >= 3 && bodyHeightPx >= 3) {
      ctx.fillStyle = theme.upWick;
      if (topBodyPx > highPx) {
        ctx.fillRect(wickLeft, highPx, geom.wickWidthPx, topBodyPx - highPx);
      }
      if (lowPx > botBodyPx) {
        ctx.fillRect(wickLeft, botBodyPx, geom.wickWidthPx, lowPx - botBodyPx);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, Math.round(rx));
      const inset = ctx.lineWidth * 0.5;
      ctx.strokeRect(
        geom.bodyLeftPx + inset,
        topBodyPx + inset,
        Math.max(1, geom.bodyWidthPx - ctx.lineWidth),
        Math.max(1, bodyHeightPx - ctx.lineWidth),
      );
      return;
    }

    // Standard filled candle (and Heikin Ashi)
    ctx.fillStyle = isUp ? theme.upWick : theme.downWick;
    ctx.fillRect(wickLeft, highPx, geom.wickWidthPx, Math.max(1, lowPx - highPx));

    ctx.fillStyle = color;
    ctx.fillRect(geom.bodyLeftPx, topBodyPx, geom.bodyWidthPx, bodyHeightPx);
  });
}

function renderPriceAxisGutter(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  ticks: Array<{ price: number; y: number; label: string }>,
  priceScale: SymlogPriceScale,
  lastBar: PlotBarView | null,
  rx: number,
  ry: number,
  theme: ChartTheme,
): void {
  ctx.save();
  clipRectBitmap(ctx, rect, rx, ry);
  ctx.setTransform(rx, 0, 0, ry, 0, 0);
  ctx.fillStyle = theme.axisText;
  ctx.font = `400 11px ${theme.monoFontFamily}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  for (const t of ticks) {
    ctx.fillText(t.label, rect.x + 7, t.y);
  }

  // Last price pill on axis
  if (lastBar) {
    const y = priceScale.priceToCoordinate(lastBar.close);
    if (y >= rect.y + 8 && y <= rect.y + rect.height - 8) {
      const pillH = 20;
      ctx.fillStyle = lastBar.close >= lastBar.open ? theme.upCandle : theme.downCandle;
      ctx.fillRect(rect.x + 1, y - pillH * 0.5, rect.width - 2, pillH);
      ctx.fillStyle = '#ffffff';
      ctx.font = `600 11px ${theme.monoFontFamily}`;
      ctx.fillText(priceScale.formatPrice(lastBar.close), rect.x + 7, y + 0.5);
    }
  }
  ctx.restore();
}

/**
 * Renders the 120 FPS interactive topCanvas: crosshair dashed lines, on-canvas OHLCV legend,
 * floating crosshair axis badges, and active pane divider hover highlight.
 */
export function renderTopLayer(input: TopRenderInput): void {
  const {
    ctx,
    metrics,
    layout,
    theme,
    symbol,
    resolution,
    plotList,
    timeScale,
    mainPriceScale,
    subPanes,
    crosshair,
    hoveredDividerIndex,
  } = input;

  const rx = metrics.horizontalPixelRatio;
  const ry = metrics.verticalPixelRatio;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, metrics.bitmapWidth, metrics.bitmapHeight);

  // Hovered divider highlight
  if (hoveredDividerIndex !== null) {
    const div = layout.dividers[hoveredDividerIndex];
    if (div) {
      ctx.fillStyle = 'rgba(41, 98, 255, 0.45)';
      ctx.fillRect(0, Math.round((div.y - 2) * ry), metrics.bitmapWidth, Math.max(3, Math.round(4 * ry)));
    }
  }

  // On-Canvas OHLCV Legend (zero React re-renders during crosshair hover!)
  const mainPane = layout.panes[0];
  if (mainPane) {
    const hoveredBar =
      crosshair.visible && crosshair.barIndex !== null
        ? plotList.getBar(crosshair.barIndex)
        : plotList.getLastBar();
    renderOnCanvasLegend(ctx, mainPane.rect, symbol, resolution, hoveredBar, mainPriceScale, rx, ry, theme);
  }

  if (!crosshair.visible) {
    ctx.restore();
    return;
  }

  // Crosshair vertical & horizontal dashed lines
  const snappedX =
    crosshair.barIndex !== null
      ? snapHairline(timeScale.indexToCoordinate(crosshair.barIndex), rx, 1)
      : snapHairline(crosshair.x, rx, 1);
  const snappedY = snapHairline(crosshair.y, ry, 1);

  ctx.save();
  ctx.strokeStyle = theme.crosshairLine;
  ctx.lineWidth = 1;
  ctx.setLineDash([4 * rx, 4 * rx]);
  ctx.beginPath();
  // Vertical line across all panes
  if (crosshair.x >= 0 && crosshair.x <= layout.plotWidth) {
    ctx.moveTo(snappedX, 0);
    ctx.lineTo(snappedX, Math.floor(layout.plotHeight * ry));
  }
  // Horizontal line across active pane
  if (crosshair.y >= 0 && crosshair.y <= layout.plotHeight) {
    ctx.moveTo(0, snappedY);
    ctx.lineTo(Math.floor(layout.plotWidth * rx), snappedY);
  }
  ctx.stroke();
  ctx.restore();

  // Floating price badge on right axis
  const targetPane = layout.panes.find((p) => p.id === crosshair.paneId);
  if (targetPane) {
    const scale =
      targetPane.id === 'main' ? mainPriceScale : subPanes.get(targetPane.id)?.priceScale;
    if (scale) {
      const price = scale.coordinateToPrice(crosshair.y);
      ctx.save();
      ctx.setTransform(rx, 0, 0, ry, 0, 0);
      const pillH = 20;
      const py = Math.max(
        targetPane.priceAxisRect.y + pillH * 0.5,
        Math.min(targetPane.priceAxisRect.y + targetPane.priceAxisRect.height - pillH * 0.5, crosshair.y),
      );
      ctx.fillStyle = theme.badgeBg;
      ctx.fillRect(targetPane.priceAxisRect.x + 1, py - pillH * 0.5, targetPane.priceAxisRect.width - 2, pillH);
      ctx.fillStyle = theme.badgeText;
      ctx.font = `600 11px ${theme.monoFontFamily}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(scale.formatPrice(price), targetPane.priceAxisRect.x + 7, py + 0.5);
      ctx.restore();
    }
  }

  // Floating time badge on bottom time axis
  if (crosshair.barIndex !== null) {
    const bar = plotList.getBar(crosshair.barIndex);
    if (bar) {
      const p = getLocalParts(bar.time, symbol.timezone);
      const label = `${p.isoDate} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
      ctx.save();
      ctx.setTransform(rx, 0, 0, ry, 0, 0);
      ctx.font = `600 11px ${theme.monoFontFamily}`;
      const textW = ctx.measureText(label).width;
      const boxW = textW + 14;
      const centerX = timeScale.indexToCoordinate(crosshair.barIndex);
      const boxX = Math.max(2, Math.min(layout.plotWidth - boxW - 2, centerX - boxW * 0.5));
      ctx.fillStyle = theme.badgeBg;
      ctx.fillRect(boxX, layout.timeAxisRect.y + 3, boxW, layout.timeAxisRect.height - 6);
      ctx.fillStyle = theme.badgeText;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, boxX + boxW * 0.5, layout.timeAxisRect.y + layout.timeAxisRect.height * 0.54);
      ctx.restore();
    }
  }

  ctx.restore();
}

function renderOnCanvasLegend(
  ctx: CanvasRenderingContext2D,
  paneRect: Rect,
  symbol: SymbolInfo,
  resolution: Resolution,
  bar: PlotBarView | null,
  priceScale: SymlogPriceScale,
  rx: number,
  ry: number,
  theme: ChartTheme,
): void {
  ctx.save();
  ctx.setTransform(rx, 0, 0, ry, 0, 0);
  const startX = paneRect.x + 12;
  const startY = paneRect.y + 18;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';

  ctx.font = `600 13px ${theme.fontFamily}`;
  ctx.fillStyle = theme.legendText;
  const title = `${symbol.ticker} · ${resolution} · ${symbol.exchange}`;
  ctx.fillText(title, startX, startY);

  if (bar) {
    const titleW = ctx.measureText(title).width;
    const isUp = bar.close >= bar.open;
    const valColor = isUp ? theme.upCandle : theme.downCandle;
    const delta = bar.close - bar.open;
    const pct = bar.open !== 0 ? (delta / bar.open) * 100 : 0;

    let x = startX + titleW + 14;
    ctx.font = `500 11.5px ${theme.monoFontFamily}`;

    const fields: Array<[string, string]> = [
      ['O ', priceScale.formatPrice(bar.open)],
      ['H ', priceScale.formatPrice(bar.high)],
      ['L ', priceScale.formatPrice(bar.low)],
      ['C ', priceScale.formatPrice(bar.close)],
    ];
    for (const [k, v] of fields) {
      ctx.fillStyle = theme.legendMuted;
      ctx.fillText(k, x, startY);
      x += ctx.measureText(k).width;
      ctx.fillStyle = valColor;
      ctx.fillText(v, x, startY);
      x += ctx.measureText(v).width + 8;
    }

    const chgText = `${delta >= 0 ? '+' : ''}${delta.toFixed(symbol.precision)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
    ctx.fillStyle = valColor;
    ctx.fillText(chgText, x, startY);
    x += ctx.measureText(chgText).width + 12;

    if (symbol.hasVolume) {
      ctx.fillStyle = theme.legendMuted;
      ctx.fillText('Vol ', x, startY);
      x += ctx.measureText('Vol ').width;
      ctx.fillStyle = theme.legendText;
      ctx.fillText(formatCompactVolume(bar.volume), x, startY);
    } else {
      ctx.fillStyle = theme.legendMuted;
      ctx.fillText('Vol N/A (Spot Index)', x, startY);
    }
  }

  ctx.restore();
}

function formatCompactVolume(vol: number): string {
  if (!Number.isFinite(vol)) return '0';
  if (vol >= 1e9) return `${(vol / 1e9).toFixed(2)}B`;
  if (vol >= 1e6) return `${(vol / 1e6).toFixed(2)}M`;
  if (vol >= 1e3) return `${(vol / 1e3).toFixed(2)}K`;
  return vol.toFixed(0);
}
