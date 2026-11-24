import type { ChartStyle, PriceScaleMode, Resolution } from './market.ts';

export interface LogicalAnchor {
  time: number;
  logicalOffset?: number;
  price: number;
}

export interface DrawingEntity {
  id: string;
  type: string;
  paneId: string;
  priceScaleId: string;
  symbol: string;
  anchors: LogicalAnchor[];
  style: Record<string, unknown>;
  locked: boolean;
  visible: boolean;
  zIndex: number;
  folderId?: string;
}

export interface ChartTileState {
  id: string;
  symbol: string;
  resolution: Resolution;
  chartStyle: ChartStyle;
  priceScaleMode: PriceScaleMode;
  inverted: boolean;
  syncGroup: 'none' | 'red' | 'blue' | 'green' | 'yellow';
  showVolume: boolean;
  useFuturesVolumeProxy: boolean;
}

export interface WorkspaceSnapshot {
  id: string;
  name: string;
  revision: number;
  updatedAt: number;
  theme: 'dark' | 'light';
  layoutGrid: '1x1' | '1x2' | '2x1' | '2x2' | '3x2' | '4x2';
  syncCrosshair: boolean;
  syncInterval: boolean;
  syncTime: boolean;
  tiles: ChartTileState[];
  drawings: DrawingEntity[];
}
