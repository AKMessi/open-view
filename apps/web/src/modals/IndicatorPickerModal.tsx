import { useState } from 'react';
import { BUILTIN_INDICATORS } from '@openview/script-runtime';

interface IndicatorPickerModalProps {
  open: boolean;
  activeIds: string[];
  hasVolume: boolean;
  onToggle: (id: string) => void;
  onClose: () => void;
}

export function IndicatorPickerModal({
  open,
  activeIds,
  hasVolume,
  onToggle,
  onClose,
}: IndicatorPickerModalProps) {
  const [query, setQuery] = useState('');
  if (!open) return null;

  const q = query.trim().toLowerCase();
  const filtered = BUILTIN_INDICATORS.filter(
    (ind) =>
      !q ||
      ind.name.toLowerCase().includes(q) ||
      ind.category.toLowerCase().includes(q) ||
      ind.description.toLowerCase().includes(q),
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/65 pt-16 backdrop-blur-xs"
      onClick={onClose}
    >
      <div
        className="flex max-h-[78vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-[#2a2e39] bg-[#131722] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#2a2e39] px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-white">
              Indicators (Rust/WASM · Unlimited)
            </h2>
            <p className="text-[11px] text-[#787b86]">
              Active: {activeIds.length} · Zero indicator cap — runs locally in WebAssembly
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded px-2 py-1 text-xs text-[#787b86] hover:bg-[#1e222d] hover:text-white"
          >
            ✕
          </button>
        </div>

        <div className="border-b border-[#2a2e39] px-4 py-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search EMA, Bollinger, SuperTrend, VWAP, RSI, MACD, ADX, Stochastic..."
            autoFocus
            className="w-full rounded border border-[#2a2e39] bg-[#0b0e14] px-3 py-1.5 text-xs text-white outline-none focus:border-[#2962ff]"
          />
        </div>

        <div className="flex-1 overflow-y-auto">
          {filtered.map((ind) => {
            const enabled = activeIds.includes(ind.id);
            const volWarn = ind.requiresVolume && !hasVolume;
            return (
              <button
                key={ind.id}
                onClick={() => onToggle(ind.id)}
                className={`flex w-full items-center justify-between border-b border-[#1e222d] px-4 py-2.5 text-left text-xs transition ${
                  enabled ? 'bg-[#2962ff]/15' : 'hover:bg-[#1a1f2d]'
                }`}
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-white">{ind.name}</span>
                    <span className="rounded bg-[#2a2e39] px-1.5 py-0.5 font-mono text-[9.5px] text-[#868993]">
                      {ind.placement}
                    </span>
                    {volWarn && (
                      <span className="rounded bg-[#f7931a]/15 px-1.5 py-0.5 text-[9.5px] text-[#f7931a]">
                        Zero-Vol Spot Index
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-[11px] text-[#787b86]">{ind.description}</div>
                </div>
                <span
                  className={`rounded px-2 py-0.5 font-mono text-[10px] font-semibold ${
                    enabled ? 'bg-[#089981]/20 text-[#089981]' : 'bg-[#2a2e39] text-[#868993]'
                  }`}
                >
                  {enabled ? 'ON' : '+ Add'}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
