export interface ChartTheme {
  name: 'dark' | 'light';
  background: string;
  paneDivider: string;
  gridLine: string;
  sessionBreakLine: string;
  axisBorder: string;
  axisText: string;
  axisTextBold: string;
  watermark: string;
  upCandle: string;
  downCandle: string;
  upWick: string;
  downWick: string;
  lineColor: string;
  areaTop: string;
  areaBottom: string;
  volUp: string;
  volDown: string;
  crosshairLine: string;
  badgeBg: string;
  badgeText: string;
  legendText: string;
  legendMuted: string;
  fontFamily: string;
  monoFontFamily: string;
}

export const DARK_THEME: ChartTheme = {
  name: 'dark',
  background: '#0b0e14',
  paneDivider: '#242936',
  gridLine: 'rgba(42, 46, 57, 0.45)',
  sessionBreakLine: 'rgba(120, 123, 134, 0.25)',
  axisBorder: '#2a2e39',
  axisText: '#868993',
  axisTextBold: '#d1d4dc',
  watermark: 'rgba(209, 212, 220, 0.055)',
  upCandle: '#089981',
  downCandle: '#f23645',
  upWick: '#089981',
  downWick: '#f23645',
  lineColor: '#2962ff',
  areaTop: 'rgba(41, 98, 255, 0.28)',
  areaBottom: 'rgba(41, 98, 255, 0.01)',
  volUp: 'rgba(8, 153, 129, 0.34)',
  volDown: 'rgba(242, 54, 69, 0.34)',
  crosshairLine: 'rgba(160, 168, 184, 0.65)',
  badgeBg: '#2a2e39',
  badgeText: '#f0f3fa',
  legendText: '#d1d4dc',
  legendMuted: '#787b86',
  fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  monoFontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
};

export const LIGHT_THEME: ChartTheme = {
  name: 'light',
  background: '#ffffff',
  paneDivider: '#e0e3eb',
  gridLine: 'rgba(224, 227, 235, 0.75)',
  sessionBreakLine: 'rgba(134, 137, 147, 0.32)',
  axisBorder: '#e0e3eb',
  axisText: '#6a6d78',
  axisTextBold: '#131722',
  watermark: 'rgba(19, 23, 34, 0.05)',
  upCandle: '#089981',
  downCandle: '#f23645',
  upWick: '#089981',
  downWick: '#f23645',
  lineColor: '#2962ff',
  areaTop: 'rgba(41, 98, 255, 0.22)',
  areaBottom: 'rgba(41, 98, 255, 0.01)',
  volUp: 'rgba(8, 153, 129, 0.30)',
  volDown: 'rgba(242, 54, 69, 0.30)',
  crosshairLine: 'rgba(106, 109, 120, 0.75)',
  badgeBg: '#131722',
  badgeText: '#ffffff',
  legendText: '#131722',
  legendMuted: '#6a6d78',
  fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  monoFontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
};
