import { useEffect, useState } from 'react';
import type { MarketClient, ProviderStatusInfo } from '../services/market-client.ts';

interface ProviderVaultModalProps {
  open: boolean;
  client: MarketClient;
  bridgeOnline: boolean;
  vaultMode?: string;
  onClose: () => void;
  onUpdated: () => void;
}

export function ProviderVaultModal({
  open,
  client,
  bridgeOnline,
  vaultMode,
  onClose,
  onUpdated,
}: ProviderVaultModalProps) {
  const [providers, setProviders] = useState<ProviderStatusInfo[]>([]);
  const [activeId, setActiveId] = useState<string>('upstox');
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [statusMsg, setStatusMsg] = useState<string>('');

  useEffect(() => {
    if (!open || !bridgeOnline) return;
    void client.listProviders().then((list) => {
      setProviders(list);
      if (list.length > 0 && !list.some((p) => p.id === activeId)) {
        setActiveId(list[0]!.id);
      }
    });
  }, [open, bridgeOnline, client, activeId]);

  if (!open) return null;

  const selected = providers.find((p) => p.id === activeId);

  const handleSave = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!selected) return;
    setStatusMsg('Encrypting & sealing into local vault...');
    const ok = await client.saveProviderCredentials(selected.id, formValues);
    if (ok) {
      setFormValues({});
      setStatusMsg(`Saved ${selected.name} encrypted in local vault (${vaultMode ?? 'AES-256-GCM'}).`);
      const refreshed = await client.listProviders();
      setProviders(refreshed);
      onUpdated();
    } else {
      setStatusMsg('Failed to save credentials.');
    }
  };

  const handleDelete = async () => {
    if (!selected) return;
    await client.deleteProviderCredentials(selected.id);
    setStatusMsg(`Removed ${selected.name} credentials.`);
    setProviders(await client.listProviders());
    onUpdated();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-xs"
      onClick={onClose}
    >
      <div
        className="flex max-h-[82vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-[#2a2e39] bg-[#131722] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#2a2e39] px-5 py-3.5">
          <div>
            <h2 className="text-sm font-semibold text-white">
              Encrypted Market Data &amp; Broker Vault
            </h2>
            <p className="text-[11px] text-[#787b86]">
              Keys are encrypted locally with AES-256-GCM ({vaultMode ?? 'DPAPI / RAM Passphrase'}) and never leave 127.0.0.1.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded px-2 py-1 text-xs text-[#787b86] hover:bg-[#1e222d] hover:text-white"
          >
            ✕
          </button>
        </div>

        {!bridgeOnline ? (
          <div className="p-6 text-xs text-[#f7931a]">
            Local Bridge Server (<code>127.0.0.1:4001</code>) is offline. Run <code>npm run dev</code> to unlock the encrypted credential vault and CORS-free Forex/Gold, US Stocks, and Indian NSE live connectors.
          </div>
        ) : (
          <div className="grid flex-1 grid-cols-12 overflow-hidden">
            <div className="col-span-5 overflow-y-auto border-r border-[#2a2e39]">
              {providers.map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    setActiveId(p.id);
                    setFormValues({});
                    setStatusMsg('');
                  }}
                  className={`flex w-full items-center justify-between border-b border-[#1e222d] px-3.5 py-2.5 text-left text-xs ${
                    p.id === activeId ? 'bg-[#1e222d]' : 'hover:bg-[#181c28]'
                  }`}
                >
                  <div>
                    <div className="font-semibold text-white">{p.name}</div>
                    <div className="text-[10px] text-[#787b86]">{p.markets.join(' · ')}</div>
                  </div>
                  <span
                    className={`rounded-full px-2 py-0.5 font-mono text-[10px] ${
                      p.configured
                        ? 'bg-[#089981]/20 text-[#089981]'
                        : 'bg-[#2a2e39] text-[#868993]'
                    }`}
                  >
                    {p.configured ? 'Connected' : 'Not set'}
                  </span>
                </button>
              ))}
            </div>

            <div className="col-span-7 overflow-y-auto p-5">
              {selected && (
                <form onSubmit={handleSave} className="space-y-4 text-xs">
                  <div>
                    <div className="text-sm font-semibold text-white">{selected.name}</div>
                    <div className="mt-0.5 text-[#089981]">{selected.costTier}</div>
                    {selected.regionNote && (
                      <div className="mt-1 inline-block rounded bg-[#f7931a]/15 px-2 py-0.5 text-[10.5px] text-[#f7931a]">
                        {selected.regionNote}
                      </div>
                    )}
                  </div>

                  {selected.fields.map((f) => (
                    <label key={f.key} className="block space-y-1">
                      <span className="text-[#868993]">{f.label}</span>
                      <input
                        type={f.secret ? 'password' : 'text'}
                        value={formValues[f.key] ?? ''}
                        placeholder={f.placeholder ?? ''}
                        onChange={(e) =>
                          setFormValues((prev) => ({ ...prev, [f.key]: e.target.value }))
                        }
                        required
                        className="w-full rounded border border-[#2a2e39] bg-[#0b0e14] px-3 py-2 font-mono text-xs text-white outline-none focus:border-[#2962ff]"
                      />
                    </label>
                  ))}

                  <div className="flex items-center gap-2 pt-2">
                    <button
                      type="submit"
                      className="rounded bg-[#2962ff] px-4 py-2 font-medium text-white hover:bg-[#1e53e5]"
                    >
                      Encrypt &amp; Save
                    </button>
                    {selected.configured && (
                      <button
                        type="button"
                        onClick={handleDelete}
                        className="rounded border border-[#f23645]/40 px-3 py-2 text-[#f23645] hover:bg-[#f23645]/10"
                      >
                        Disconnect
                      </button>
                    )}
                  </div>

                  {statusMsg && <div className="font-mono text-[11px] text-[#6aa0ff]">{statusMsg}</div>}
                </form>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
