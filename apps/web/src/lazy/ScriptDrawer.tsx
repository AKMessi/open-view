import { useState } from 'react';
import { PINE_TEMPLATES, SCRIPT_TEMPLATES } from '@openview/script-runtime';

export interface ScriptDrawerProps {
  open: boolean;
  code: string;
  logs: string[];
  error?: string;
  elapsedMs?: number;
  isDark: boolean;
  onChangeCode: (next: string) => void;
  onRun: () => void;
  onClearScript: () => void;
  onClose: () => void;
}

const ALL_TEMPLATES: Record<string, { title: string; code: string }> = {
  ...PINE_TEMPLATES,
  ...SCRIPT_TEMPLATES,
};

export default function ScriptDrawer({
  open,
  code,
  logs,
  error,
  elapsedMs,
  isDark,
  onChangeCode,
  onRun,
  onClearScript,
  onClose,
}: ScriptDrawerProps) {
  const [templateKey, setTemplateKey] = useState('pine_ema_cross');
  if (!open) return null;

  const isPineMode =
    code.includes('//@version=') || /\b(indicator|strategy)\s*\(/.test(code);

  return (
    <section
      className={`flex h-64 shrink-0 flex-col border-t ${
        isDark ? 'border-[#2a2e39] bg-[#131722]' : 'border-[#e0e3eb] bg-white'
      }`}
    >
      <div
        className={`flex items-center justify-between border-b px-3 py-1.5 text-xs ${
          isDark ? 'border-[#2a2e39]' : 'border-[#e0e3eb]'
        }`}
      >
        <div className="flex items-center gap-2">
          <span className="font-semibold text-white">
            Script Editor
          </span>
          <span
            className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${
              isPineMode ? 'bg-[#089981]/20 text-[#089981]' : 'bg-[#2962ff]/20 text-[#6aa0ff]'
            }`}
          >
            {isPineMode ? 'PINE v5/v6 · RUST WASM VM' : 'TYPESCRIPT SDK · WASM TA'}
          </span>
          <select
            value={templateKey}
            onChange={(e) => {
              setTemplateKey(e.target.value);
              const tpl = ALL_TEMPLATES[e.target.value];
              if (tpl) onChangeCode(tpl.code);
            }}
            className="rounded border border-[#2a2e39] bg-[#1e222d] px-2 py-0.5 text-[11px] text-[#d1d4dc]"
          >
            {Object.entries(ALL_TEMPLATES).map(([k, v]) => (
              <option key={k} value={k}>
                {v.title}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          {elapsedMs !== undefined && (
            <span className="font-mono text-[10.5px] text-[#089981]">
              Evaluated in {elapsedMs}ms
            </span>
          )}
          <button
            onClick={onRun}
            className="rounded bg-[#2962ff] px-3 py-1 text-[11px] font-semibold text-white hover:bg-[#1e53e5]"
          >
            ▶ Add / Run on Chart
          </button>
          <button
            onClick={onClearScript}
            className="rounded border border-[#2a2e39] px-2 py-1 text-[11px] text-[#868993] hover:text-white"
          >
            Clear Plots
          </button>
          <button
            onClick={onClose}
            className="rounded px-1.5 py-1 text-xs text-[#787b86] hover:text-white"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="grid flex-1 grid-cols-12 overflow-hidden">
        <textarea
          value={code}
          onChange={(e) => onChangeCode(e.target.value)}
          spellCheck={false}
          className={`col-span-8 h-full resize-none border-r p-3 font-mono text-xs outline-none ${
            isDark
              ? 'border-[#2a2e39] bg-[#0b0e14] text-[#d1d4dc]'
              : 'border-[#e0e3eb] bg-[#f8f9fd] text-[#131722]'
          }`}
        />
        <div className="col-span-4 overflow-y-auto p-3 font-mono text-[11px]">
          <div className="mb-1 text-[10px] font-semibold uppercase text-[#787b86]">
            Pine Linter &amp; Console
          </div>
          {error && (
            <div className="mb-2 rounded border border-[#f23645]/40 bg-[#f23645]/10 p-2 text-[#f23645]">
              Error: {error}
            </div>
          )}
          {logs.length === 0 && !error ? (
            <div className="text-[#787b86]">
              Write Pine v5/v6 or TypeScript SDK indicators and click "Add / Run on Chart".
            </div>
          ) : (
            logs.map((line, i) => (
              <div
                key={i}
                className={`border-b border-[#1e222d] py-1 ${
                  line.includes('WARNING') ? 'text-[#f7931a]' : 'text-[#d1d4dc]'
                }`}
              >
                &gt; {line}
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}
