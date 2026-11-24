export type DrawingToolGroup =
  | 'lines'
  | 'channels'
  | 'fibonacci'
  | 'shapes'
  | 'annotations'
  | 'measure_rr';

export type DrawingToolType =
  // Lines & Rays (9)
  | 'trendline'
  | 'ray'
  | 'info_line'
  | 'extended_line'
  | 'trend_angle'
  | 'horizontal_line'
  | 'horizontal_ray'
  | 'vertical_line'
  | 'cross_line'
  // Channels (3)
  | 'parallel_channel'
  | 'disjoint_channel'
  | 'flat_channel'
  // Fibonacci (3)
  | 'fib_retracement'
  | 'fib_extension'
  | 'fib_channel'
  // Shapes (8)
  | 'rectangle'
  | 'rotated_rectangle'
  | 'circle'
  | 'ellipse'
  | 'triangle'
  | 'polyline'
  | 'brush'
  | 'highlighter'
  // Annotations (7)
  | 'text'
  | 'anchored_text'
  | 'note'
  | 'callout'
  | 'price_label'
  | 'arrow_up'
  | 'arrow_down'
  // Measure, Risk-Reward & Institutional Anchor Tools (7)
  | 'measure'
  | 'date_range'
  | 'price_range'
  | 'date_price_range'
  | 'long_position'
  | 'short_position'
  | 'anchored_vwap';

export interface DrawingToolDefinition {
  type: DrawingToolType;
  label: string;
  shortLabel: string;
  group: DrawingToolGroup;
  requiredAnchors: number | 'freehand';
  shortcut?: string;
  defaultColor: string;
  defaultLineWidth: number;
}

export const DRAWING_TOOLS: readonly DrawingToolDefinition[] = [
  // Lines & Rays
  { type: 'trendline', label: 'Trend Line', shortLabel: 'TL', group: 'lines', requiredAnchors: 2, shortcut: 'Alt+T', defaultColor: '#2962ff', defaultLineWidth: 2 },
  { type: 'ray', label: 'Ray', shortLabel: 'RAY', group: 'lines', requiredAnchors: 2, defaultColor: '#2962ff', defaultLineWidth: 2 },
  { type: 'info_line', label: 'Info Line', shortLabel: 'INF', group: 'lines', requiredAnchors: 2, defaultColor: '#2962ff', defaultLineWidth: 2 },
  { type: 'extended_line', label: 'Extended Line', shortLabel: 'EXT', group: 'lines', requiredAnchors: 2, defaultColor: '#2962ff', defaultLineWidth: 1.5 },
  { type: 'trend_angle', label: 'Trend Angle', shortLabel: 'ANG', group: 'lines', requiredAnchors: 2, defaultColor: '#2962ff', defaultLineWidth: 1.5 },
  { type: 'horizontal_line', label: 'Horizontal Line', shortLabel: 'HL', group: 'lines', requiredAnchors: 1, shortcut: 'Alt+H', defaultColor: '#f7931a', defaultLineWidth: 1.5 },
  { type: 'horizontal_ray', label: 'Horizontal Ray', shortLabel: 'HR', group: 'lines', requiredAnchors: 1, shortcut: 'Alt+J', defaultColor: '#f7931a', defaultLineWidth: 1.5 },
  { type: 'vertical_line', label: 'Vertical Line', shortLabel: 'VL', group: 'lines', requiredAnchors: 1, shortcut: 'Alt+V', defaultColor: '#787b86', defaultLineWidth: 1.5 },
  { type: 'cross_line', label: 'Cross Line', shortLabel: 'CL', group: 'lines', requiredAnchors: 1, defaultColor: '#787b86', defaultLineWidth: 1.5 },

  // Channels
  { type: 'parallel_channel', label: 'Parallel Channel', shortLabel: 'CH', group: 'channels', requiredAnchors: 3, defaultColor: '#2962ff', defaultLineWidth: 1.5 },
  { type: 'disjoint_channel', label: 'Disjoint Channel', shortLabel: 'DCH', group: 'channels', requiredAnchors: 3, defaultColor: '#2962ff', defaultLineWidth: 1.5 },
  { type: 'flat_channel', label: 'Flat Top/Bottom', shortLabel: 'FCH', group: 'channels', requiredAnchors: 3, defaultColor: '#26a69a', defaultLineWidth: 1.5 },

  // Fibonacci
  { type: 'fib_retracement', label: 'Fib Retracement', shortLabel: 'FIB', group: 'fibonacci', requiredAnchors: 2, shortcut: 'Alt+F', defaultColor: '#787b86', defaultLineWidth: 1 },
  { type: 'fib_extension', label: 'Trend-Based Fib Extension', shortLabel: 'FEX', group: 'fibonacci', requiredAnchors: 3, defaultColor: '#2962ff', defaultLineWidth: 1 },
  { type: 'fib_channel', label: 'Fib Channel', shortLabel: 'FC', group: 'fibonacci', requiredAnchors: 3, defaultColor: '#7e57c2', defaultLineWidth: 1 },

  // Shapes
  { type: 'rectangle', label: 'Rectangle', shortLabel: 'REC', group: 'shapes', requiredAnchors: 2, defaultColor: '#2962ff', defaultLineWidth: 1.5 },
  { type: 'rotated_rectangle', label: 'Rotated Rectangle', shortLabel: 'RRC', group: 'shapes', requiredAnchors: 3, defaultColor: '#2962ff', defaultLineWidth: 1.5 },
  { type: 'circle', label: 'Circle', shortLabel: 'CIR', group: 'shapes', requiredAnchors: 2, defaultColor: '#26a69a', defaultLineWidth: 1.5 },
  { type: 'ellipse', label: 'Ellipse', shortLabel: 'ELP', group: 'shapes', requiredAnchors: 3, defaultColor: '#26a69a', defaultLineWidth: 1.5 },
  { type: 'triangle', label: 'Triangle', shortLabel: 'TRI', group: 'shapes', requiredAnchors: 3, defaultColor: '#ab47bc', defaultLineWidth: 1.5 },
  { type: 'polyline', label: 'Path / Polyline', shortLabel: 'PLY', group: 'shapes', requiredAnchors: 3, defaultColor: '#2962ff', defaultLineWidth: 2 },
  { type: 'brush', label: 'Brush', shortLabel: 'BRS', group: 'shapes', requiredAnchors: 'freehand', defaultColor: '#2962ff', defaultLineWidth: 2 },
  { type: 'highlighter', label: 'Highlighter', shortLabel: 'HGL', group: 'shapes', requiredAnchors: 'freehand', defaultColor: '#ffeb3b', defaultLineWidth: 10 },

  // Annotations
  { type: 'text', label: 'Text', shortLabel: 'TXT', group: 'annotations', requiredAnchors: 1, defaultColor: '#d1d4dc', defaultLineWidth: 1 },
  { type: 'anchored_text', label: 'Anchored Text', shortLabel: 'ATX', group: 'annotations', requiredAnchors: 1, defaultColor: '#d1d4dc', defaultLineWidth: 1 },
  { type: 'note', label: 'Note', shortLabel: 'NOT', group: 'annotations', requiredAnchors: 1, defaultColor: '#f7931a', defaultLineWidth: 1 },
  { type: 'callout', label: 'Callout', shortLabel: 'CAL', group: 'annotations', requiredAnchors: 2, defaultColor: '#2962ff', defaultLineWidth: 1.5 },
  { type: 'price_label', label: 'Price Label', shortLabel: 'LBL', group: 'annotations', requiredAnchors: 1, defaultColor: '#2962ff', defaultLineWidth: 1 },
  { type: 'arrow_up', label: 'Arrow Mark Up', shortLabel: 'UP', group: 'annotations', requiredAnchors: 1, defaultColor: '#089981', defaultLineWidth: 2 },
  { type: 'arrow_down', label: 'Arrow Mark Down', shortLabel: 'DN', group: 'annotations', requiredAnchors: 1, defaultColor: '#f23645', defaultLineWidth: 2 },

  // Measurements, Risk-Reward & Anchored VWAP
  { type: 'long_position', label: 'Long Position (R:R)', shortLabel: 'LNG', group: 'measure_rr', requiredAnchors: 3, defaultColor: '#089981', defaultLineWidth: 1.5 },
  { type: 'short_position', label: 'Short Position (R:R)', shortLabel: 'SHT', group: 'measure_rr', requiredAnchors: 3, defaultColor: '#f23645', defaultLineWidth: 1.5 },
  { type: 'anchored_vwap', label: 'Anchored VWAP (±1σ, 2σ)', shortLabel: 'AVW', group: 'measure_rr', requiredAnchors: 1, defaultColor: '#ff9800', defaultLineWidth: 2 },
  { type: 'measure', label: 'Measure (Price & Bars)', shortLabel: 'MSR', group: 'measure_rr', requiredAnchors: 2, defaultColor: '#2962ff', defaultLineWidth: 1.5 },
  { type: 'date_range', label: 'Date Range', shortLabel: 'DRG', group: 'measure_rr', requiredAnchors: 2, defaultColor: '#2962ff', defaultLineWidth: 1.5 },
  { type: 'price_range', label: 'Price Range', shortLabel: 'PRG', group: 'measure_rr', requiredAnchors: 2, defaultColor: '#2962ff', defaultLineWidth: 1.5 },
  { type: 'date_price_range', label: 'Date & Price Range', shortLabel: 'DPR', group: 'measure_rr', requiredAnchors: 2, defaultColor: '#2962ff', defaultLineWidth: 1.5 },
];

const toolDefMap = new Map<DrawingToolType, DrawingToolDefinition>(
  DRAWING_TOOLS.map((t) => [t.type, t]),
);

export function getToolDefinition(type: string): DrawingToolDefinition {
  return toolDefMap.get(type as DrawingToolType) ?? DRAWING_TOOLS[0]!;
}

export const FIB_DEFAULT_LEVELS: readonly { ratio: number; color: string }[] = [
  { ratio: 0, color: '#787b86' },
  { ratio: 0.236, color: '#f23645' },
  { ratio: 0.382, color: '#ff9800' },
  { ratio: 0.5, color: '#089981' },
  { ratio: 0.618, color: '#2962ff' },
  { ratio: 0.786, color: '#26c6da' },
  { ratio: 1, color: '#787b86' },
  { ratio: 1.618, color: '#ab47bc' },
];
