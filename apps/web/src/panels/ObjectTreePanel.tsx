import { getToolDefinition, type DrawingManager } from '@openview/drawings';

interface ObjectTreePanelProps {
  symbolId: string;
  drawingManager: DrawingManager;
  revision: number;
  isDark: boolean;
}

export function ObjectTreePanel({
  symbolId,
  drawingManager,
  revision,
  isDark,
}: ObjectTreePanelProps) {
  void revision;
  const drawings = drawingManager.getDrawings(symbolId).reverse();

  return (
    <aside
      className={`flex h-full w-60 shrink-0 flex-col border-l text-xs ${
        isDark ? 'border-[#2a2e39] bg-[#131722]' : 'border-[#e0e3eb] bg-white'
      }`}
    >
      <div
        className={`flex items-center justify-between border-b px-3 py-2 ${
          isDark ? 'border-[#2a2e39]' : 'border-[#e0e3eb]'
        }`}
      >
        <span className="font-semibold tracking-wide uppercase text-[#868993]">
          Object Tree ({drawings.length})
        </span>
        {drawings.length > 0 && (
          <button
            onClick={() => drawingManager.clearForSymbol(symbolId)}
            className="text-[10px] text-[#f23645] hover:underline"
          >
            Clear
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {drawings.length === 0 ? (
          <div className="p-4 text-center text-[11px] text-[#787b86]">
            No drawings on <span className="font-mono">{symbolId}</span> yet. Select any tool on the
            left bar (or press Alt+T / Alt+H / Alt+F).
          </div>
        ) : (
          drawings.map((d) => {
            const def = getToolDefinition(d.type);
            const isSel = drawingManager.selectedId === d.id;
            return (
              <div
                key={d.id}
                onClick={() => {
                  drawingManager.selectedId = d.id;
                }}
                className={`flex cursor-pointer items-center justify-between border-b px-3 py-2 text-[11px] ${
                  isDark ? 'border-[#1a1e2a]' : 'border-[#f0f3fa]'
                } ${isSel ? 'bg-[#2962ff]/20' : isDark ? 'hover:bg-[#1b202e]' : 'hover:bg-[#f4f6fb]'}`}
              >
                <div className="flex items-center gap-2 overflow-hidden">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ background: String(d.style.color ?? '#2962ff') }}
                  />
                  <span className={`truncate ${isDark ? 'text-white' : 'text-[#131722]'}`}>
                    {def.label}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      drawingManager.toggleVisibility(d.id);
                    }}
                    className="rounded px-1 text-[10px] text-[#868993] hover:text-white"
                    title="Toggle visibility"
                  >
                    {d.visible ? '👁' : '⊘'}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      drawingManager.toggleLock(d.id);
                    }}
                    className="rounded px-1 text-[10px] text-[#868993] hover:text-white"
                    title="Lock/Unlock"
                  >
                    {d.locked ? '🔒' : '🔓'}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      drawingManager.deleteDrawing(d.id);
                    }}
                    className="rounded px-1 text-[10px] text-[#f23645]"
                    title="Delete"
                  >
                    ✕
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
