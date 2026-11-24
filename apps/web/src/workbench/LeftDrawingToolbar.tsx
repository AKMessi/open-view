import { useState } from 'react';
import {
  DRAWING_TOOLS,
  type DrawingToolGroup,
  type DrawingToolType,
  type MagnetMode,
} from '@openview/drawings';

interface LeftDrawingToolbarProps {
  activeTool: DrawingToolType | null;
  magnetMode: MagnetMode;
  stayInMode: boolean;
  hideAll: boolean;
  canUndo: boolean;
  canRedo: boolean;
  isDark: boolean;
  onSelectTool: (tool: DrawingToolType | null) => void;
  onCycleMagnet: () => void;
  onToggleStayInMode: () => void;
  onToggleHideAll: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onClearDrawings: () => void;
}

const GROUPS: Array<{ id: DrawingToolGroup; icon: string; title: string; defaultTool: DrawingToolType }> = [
  { id: 'lines', icon: '╱', title: 'Lines & Rays', defaultTool: 'trendline' },
  { id: 'channels', icon: '⫽', title: 'Channels & Pitchforks', defaultTool: 'parallel_channel' },
  { id: 'fibonacci', icon: '≡', title: 'Fibonacci & Gann', defaultTool: 'fib_retracement' },
  { id: 'patterns', icon: '∿', title: 'Elliott, Harmonics & Cycles', defaultTool: 'harmonic_xabcd' },
  { id: 'shapes', icon: '▭', title: 'Geometric Shapes & Brush', defaultTool: 'rectangle' },
  { id: 'annotations', icon: 'T', title: 'Text & Annotations', defaultTool: 'text' },
  { id: 'measure_rr', icon: '⊞', title: 'R:R, Anchored VWAP, FRVP & Measure', defaultTool: 'long_position' },
];

export function LeftDrawingToolbar({
  activeTool,
  magnetMode,
  stayInMode,
  hideAll,
  canUndo,
  canRedo,
  isDark,
  onSelectTool,
  onCycleMagnet,
  onToggleStayInMode,
  onToggleHideAll,
  onUndo,
  onRedo,
  onClearDrawings,
}: LeftDrawingToolbarProps) {
  const [openGroup, setOpenGroup] = useState<DrawingToolGroup | null>(null);

  const btnBase = `flex h-8 w-8 items-center justify-center rounded text-xs font-mono transition ${
    isDark ? 'text-[#868993] hover:bg-[#1e222d] hover:text-white' : 'text-[#6a6d78] hover:bg-[#f0f3fa] hover:text-[#131722]'
  }`;

  return (
    <aside
      className={`relative z-30 flex w-11 shrink-0 flex-col items-center gap-1 border-r py-2 select-none ${
        isDark ? 'border-[#2a2e39] bg-[#131722]' : 'border-[#e0e3eb] bg-white'
      }`}
    >
      {/* Crosshair / Cursor Reset */}
      <button
        onClick={() => {
          onSelectTool(null);
          setOpenGroup(null);
        }}
        className={`${btnBase} ${activeTool === null ? 'bg-[#2962ff]/20 text-[#2962ff]' : ''}`}
        title="Crosshair / Select (Esc)"
      >
        ┼
      </button>

      <div className="my-1 h-px w-6 bg-[#2a2e39]" />

      {/* Tool Groups with Flyout Picker */}
      {GROUPS.map((g) => {
        const groupTools = DRAWING_TOOLS.filter((t) => t.group === g.id);
        const isGroupActive = groupTools.some((t) => t.type === activeTool);
        return (
          <div key={g.id} className="relative">
            <button
              onClick={() => {
                if (openGroup === g.id) {
                  setOpenGroup(null);
                } else {
                  setOpenGroup(g.id);
                  if (!isGroupActive) onSelectTool(g.defaultTool);
                }
              }}
              className={`${btnBase} ${isGroupActive ? 'bg-[#2962ff] text-white' : ''}`}
              title={g.title}
            >
              {g.icon}
            </button>

            {openGroup === g.id && (
              <div
                className={`absolute top-0 left-11 z-40 w-56 rounded-md border py-1 shadow-xl ${
                  isDark ? 'border-[#2a2e39] bg-[#131722]' : 'border-[#d1d4dc] bg-white'
                }`}
              >
                <div className="border-b border-[#2a2e39]/60 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-[#787b86]">
                  {g.title}
                </div>
                {groupTools.map((tool) => (
                  <button
                    key={tool.type}
                    onClick={() => {
                      onSelectTool(tool.type);
                      setOpenGroup(null);
                    }}
                    className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-xs ${
                      activeTool === tool.type
                        ? 'bg-[#2962ff]/20 text-[#6aa0ff]'
                        : isDark
                          ? 'text-[#d1d4dc] hover:bg-[#1e222d]'
                          : 'text-[#131722] hover:bg-[#f0f3fa]'
                    }`}
                  >
                    <span>{tool.label}</span>
                    {tool.shortcut && (
                      <span className="font-mono text-[10px] text-[#787b86]">{tool.shortcut}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}

      <div className="my-1 h-px w-6 bg-[#2a2e39]" />

      {/* Magnet Weak / Strong */}
      <button
        onClick={onCycleMagnet}
        className={`${btnBase} ${
          magnetMode === 'strong'
            ? 'bg-[#f7931a]/25 text-[#f7931a]'
            : magnetMode === 'weak'
              ? 'bg-[#2962ff]/25 text-[#6aa0ff]'
              : ''
        }`}
        title={`OHLC Magnet: ${magnetMode.toUpperCase()} (Click to cycle Off / Weak / Strong)`}
      >
        🧲
      </button>

      {/* Stay in Drawing Mode */}
      <button
        onClick={onToggleStayInMode}
        className={`${btnBase} ${stayInMode ? 'bg-[#2962ff]/25 text-[#6aa0ff]' : ''}`}
        title="Stay in Drawing Mode"
      >
        ✎
      </button>

      {/* Hide All Drawings */}
      <button
        onClick={onToggleHideAll}
        className={`${btnBase} ${hideAll ? 'bg-[#f23645]/20 text-[#f23645]' : ''}`}
        title={hideAll ? 'Show All Drawings' : 'Hide All Drawings'}
      >
        {hideAll ? '⊘' : '👁'}
      </button>

      <div className="my-1 h-px w-6 bg-[#2a2e39]" />

      {/* Undo / Redo */}
      <button
        onClick={onUndo}
        disabled={!canUndo}
        className={`${btnBase} disabled:opacity-30`}
        title="Undo Drawing (Ctrl+Z)"
      >
        ↶
      </button>
      <button
        onClick={onRedo}
        disabled={!canRedo}
        className={`${btnBase} disabled:opacity-30`}
        title="Redo Drawing (Ctrl+Y)"
      >
        ↷
      </button>

      <button
        onClick={onClearDrawings}
        className={`${btnBase} mt-auto text-[#f23645]/80 hover:text-[#f23645]`}
        title="Remove All Drawings on Active Symbol"
      >
        🗑
      </button>
    </aside>
  );
}
