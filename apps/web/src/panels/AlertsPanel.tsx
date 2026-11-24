import { useEffect, useState } from 'react';
import type { OHLCVBar, SymbolInfo } from '@openview/protocol';
import type { AlertRuleClient, AlertTriggerEventClient, MarketClient } from '../services/market-client.ts';

interface AlertsPanelProps {
  symbol: SymbolInfo;
  latestBar: OHLCVBar | null;
  client: MarketClient;
  bridgeOnline: boolean;
  liveEvents: AlertTriggerEventClient[];
  isDark: boolean;
}

export function AlertsPanel({
  symbol,
  latestBar,
  client,
  bridgeOnline,
  liveEvents,
  isDark,
}: AlertsPanelProps) {
  const [alerts, setAlerts] = useState<AlertRuleClient[]>([]);
  const [events, setEvents] = useState<AlertTriggerEventClient[]>([]);
  const [operator, setOperator] = useState<'crossing_up' | 'crossing_down' | 'crossing'>('crossing_up');
  const [targetPrice, setTargetPrice] = useState('');
  const [frequency, setFrequency] = useState<'only_once' | 'once_per_bar' | 'once_per_bar_close'>('only_once');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookFormat, setWebhookFormat] = useState<'generic' | 'discord' | 'telegram'>('generic');
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<string | null>(null);

  const refresh = async () => {
    if (!bridgeOnline) return;
    const [a, e] = await Promise.all([client.listAlerts(), client.listAlertEvents()]);
    setAlerts(a);
    setEvents(e);
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridgeOnline, liveEvents.length]);

  const handleCreate = async () => {
    const px = Number(targetPrice || latestBar?.close || 0);
    if (!Number.isFinite(px) || px <= 0) {
      setStatus('Enter a valid target price.');
      return;
    }
    const ok = await client.createAlert({
      name: `${symbol.ticker} ${operator.replace('_', ' ')} ${px}`,
      symbol: symbol.id,
      resolution: '15',
      kind: 'price',
      operator,
      frequency,
      targetPrice: px,
      ...(webhookUrl.trim() ? { webhookUrl: webhookUrl.trim(), webhookFormat } : {}),
      message: message.trim() || `${symbol.ticker} hit ${px}`,
    });
    if (ok) {
      setStatus('Alert saved to SQLite WAL worker.');
      setTargetPrice('');
      setMessage('');
      await refresh();
    } else {
      setStatus('Bridge offline — start local bridge to persist 24/7 alerts.');
    }
  };

  const mergedEvents = [...liveEvents, ...events].filter(
    (ev, idx, arr) => arr.findIndex((x) => x.id === ev.id) === idx,
  );

  return (
    <aside
      className={`flex w-72 shrink-0 flex-col border-l text-xs ${
        isDark ? 'border-[#2a2e39] bg-[#131722] text-[#d1d4dc]' : 'border-[#e0e3eb] bg-white text-[#131722]'
      }`}
    >
      <div className="flex items-center justify-between border-b border-[#2a2e39] px-3 py-2">
        <span className="font-semibold text-white">24/7 Alerts Engine</span>
        <span className="rounded bg-[#2962ff]/15 px-1.5 py-0.5 font-mono text-[9.5px] text-[#6aa0ff]">
          SSRF + HMAC
        </span>
      </div>

      {/* Create Alert Form */}
      <div className="space-y-2 border-b border-[#2a2e39] p-3">
        <div className="flex items-center justify-between text-[11px]">
          <span className="font-mono font-semibold text-white">{symbol.ticker}</span>
          <span className="font-mono text-[#787b86]">
            Last: {latestBar ? latestBar.close.toFixed(symbol.precision) : '—'}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-1.5">
          <select
            value={operator}
            onChange={(e) => setOperator(e.target.value as 'crossing_up' | 'crossing_down' | 'crossing')}
            className="rounded border border-[#2a2e39] bg-[#0b0e14] px-2 py-1 text-[11px] text-white"
          >
            <option value="crossing_up">Crossing Up</option>
            <option value="crossing_down">Crossing Down</option>
            <option value="crossing">Crossing Either</option>
          </select>
          <input
            type="number"
            step="any"
            placeholder={latestBar ? latestBar.close.toFixed(symbol.precision) : 'Price'}
            value={targetPrice}
            onChange={(e) => setTargetPrice(e.target.value)}
            className="rounded border border-[#2a2e39] bg-[#0b0e14] px-2 py-1 font-mono text-[11px] text-white"
          />
        </div>

        <div className="grid grid-cols-2 gap-1.5">
          <select
            value={frequency}
            onChange={(e) => setFrequency(e.target.value as 'only_once' | 'once_per_bar' | 'once_per_bar_close')}
            className="rounded border border-[#2a2e39] bg-[#0b0e14] px-2 py-1 text-[11px] text-white"
          >
            <option value="only_once">Only Once</option>
            <option value="once_per_bar">Once Per Bar</option>
            <option value="once_per_bar_close">Once Per Bar Close</option>
          </select>
          <select
            value={webhookFormat}
            onChange={(e) => setWebhookFormat(e.target.value as 'generic' | 'discord' | 'telegram')}
            className="rounded border border-[#2a2e39] bg-[#0b0e14] px-2 py-1 text-[11px] text-white"
          >
            <option value="generic">Webhook JSON</option>
            <option value="discord">Discord</option>
            <option value="telegram">Telegram</option>
          </select>
        </div>

        <input
          type="url"
          placeholder="Optional Webhook URL (SSRF-guarded)"
          value={webhookUrl}
          onChange={(e) => setWebhookUrl(e.target.value)}
          className="w-full rounded border border-[#2a2e39] bg-[#0b0e14] px-2 py-1 font-mono text-[11px] text-white placeholder:text-[#5d606b]"
        />
        <input
          type="text"
          placeholder="Alert message..."
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          className="w-full rounded border border-[#2a2e39] bg-[#0b0e14] px-2 py-1 text-[11px] text-white placeholder:text-[#5d606b]"
        />

        <button
          onClick={() => void handleCreate()}
          className="w-full rounded bg-[#2962ff] py-1.5 font-semibold text-white hover:bg-[#1e53e5]"
        >
          + Create 24/7 Alert
        </button>

        {status && <div className="font-mono text-[10px] text-[#089981]">{status}</div>}
      </div>

      {/* Active Alerts & Audit Log */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase text-[#787b86]">
            Active Rules ({alerts.length})
          </div>
          {alerts.length === 0 ? (
            <div className="text-[11px] text-[#5d606b]">No server alerts yet.</div>
          ) : (
            alerts.map((a) => (
              <div
                key={a.id}
                className="mb-1.5 flex items-center justify-between rounded border border-[#2a2e39] bg-[#0b0e14] px-2 py-1.5"
              >
                <div className="min-w-0">
                  <div className="truncate font-mono text-[11px] font-semibold text-white">
                    {a.symbol.split(':')[1] ?? a.symbol} · {a.targetPrice ?? 'Line'}
                  </div>
                  <div className="text-[10px] text-[#787b86]">
                    {a.operator} · {a.enabled ? 'ACTIVE' : 'FIRED'} ({a.triggerCount})
                  </div>
                </div>
                <button
                  onClick={async () => {
                    await client.deleteAlert(a.id);
                    await refresh();
                  }}
                  className="ml-2 text-[#f23645] hover:underline"
                >
                  ✕
                </button>
              </div>
            ))
          )}
        </div>

        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase text-[#787b86]">
            Trigger Audit Log ({mergedEvents.length})
          </div>
          {mergedEvents.slice(0, 15).map((ev) => (
            <div key={ev.id} className="mb-1 rounded border border-[#2a2e39]/60 bg-[#0b0e14] px-2 py-1 text-[10.5px]">
              <div className="font-mono font-semibold text-[#f7931a]">{ev.alertName}</div>
              <div className="text-[#868993]">{ev.message}</div>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}
