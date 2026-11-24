import type { ReplaySnapshot } from '@openview/replay-engine';

interface ReplayBarProps {
  snapshot: ReplaySnapshot;
  onPlayPause: () => void;
  onStepBack: () => void;
  onStepForward: () => void;
  onSpeedChange: (bps: number) => void;
  onJump: (index: number) => void;
  onExit: () => void;
}

const SPEEDS = [0.5, 1, 2, 5, 10, 20];

export function ReplayBar({
  snapshot,
  onPlayPause,
  onStepBack,
  onStepForward,
  onSpeedChange,
  onJump,
  onExit,
}: ReplayBarProps) {
  if (!snapshot.active) return null;

  return (
    <div className="flex h-9 shrink-0 items-center justify-between gap-3 border-b border-[#f7931a]/40 bg-[#1a1610] px-3 font-mono text-xs text-[#f0f3fa]">
      <div className="flex items-center gap-2">
        <span className="rounded bg-[#f7931a]/25 px-2 py-0.5 text-[10px] font-bold text-[#f7931a]">
          ◷ BAR REPLAY (ZERO-LOOKAHEAD)
        </span>

        <button
          onClick={onStepBack}
          className="rounded border border-[#2a2e39] px-2 py-0.5 hover:bg-[#2a2e39]"
          title="Step Back 1 Bar"
        >
          ⏮
        </button>
        <button
          onClick={onPlayPause}
          className="rounded bg-[#2962ff] px-3 py-0.5 font-semibold text-white hover:bg-[#1e53e5]"
        >
          {snapshot.playing ? '⏸ Pause' : '▶ Play'}
        </button>
        <button
          onClick={onStepForward}
          className="rounded border border-[#2a2e39] px-2 py-0.5 hover:bg-[#2a2e39]"
          title="Step Forward 1 Bar"
        >
          ⏭
        </button>

        <select
          value={snapshot.speedBarsPerSec}
          onChange={(e) => onSpeedChange(Number(e.target.value))}
          className="rounded border border-[#2a2e39] bg-[#131722] px-1.5 py-0.5 text-[11px] text-[#d1d4dc]"
        >
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s} bar/s
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-1 items-center gap-3">
        <input
          type="range"
          min={10}
          max={Math.max(10, snapshot.totalBaseBars - 1)}
          value={snapshot.cursorIndex}
          onChange={(e) => onJump(Number(e.target.value))}
          className="w-full accent-[#f7931a]"
        />
        <span className="shrink-0 text-[11px] text-[#d1d4dc]">
          Bar {snapshot.cursorIndex + 1}/{snapshot.totalBaseBars} ·{' '}
          {snapshot.cursorTime ? new Date(snapshot.cursorTime).toISOString().slice(0, 16).replace('T', ' ') : ''}
        </span>
      </div>

      <button
        onClick={onExit}
        className="rounded border border-[#f23645]/40 px-2 py-0.5 text-[11px] text-[#f23645] hover:bg-[#f23645]/15"
      >
        Exit Replay
      </button>
    </div>
  );
}
