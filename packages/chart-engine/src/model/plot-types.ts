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

export interface MainOverlayPlot {
  id: string;
  title: string;
  kind: 'line' | 'band_fill' | 'supertrend';
  color: string;
  secondaryColor?: string;
  lineWidth?: number;
  startBarIndex: number;
  values: Float64Array;
  /** Optional upper/lower pair for band_fill or direction (+1/-1) array for supertrend */
  extraValues?: Float64Array;
  lowerValues?: Float64Array;
}
