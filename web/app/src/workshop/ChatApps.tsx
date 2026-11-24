import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useLang } from '@gestalts/i18n';
import * as api from './api';

export function ChatApps() {
  const { m, lang } = useLang();
  const [list, setList] = useState<api.Connection[]>();
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);
  const url = api.mcpUrl();
  const load = () => api.connections().then(setList, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  useEffect(() => { void load(); }, []);
  const copy = async () => {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const drop = async (client: string) => {
    try { await api.disconnect(client); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    await load();
  };
  return (
    <details className="dropdown dropdown-end">
      <summary className="btn btn-sm btn-ghost">{m.settings_host()}</summary>
      <section className="dropdown-content z-30 mt-2 flex w-80 max-w-[90vw] flex-col gap-2 rounded-box border border-base-300 bg-base-100 p-3 text-sm">
        <p className="text-base-content/60">{m.settings_host_about()}</p>
        <div className="flex gap-1">
          <input className="input input-sm min-w-0 flex-1 font-mono" readOnly value={url} onFocus={(e) => e.target.select()} />
          <button type="button" className="btn btn-sm btn-square" onClick={() => void copy()} title={m.copy()} aria-label={m.copy()}>{copied ? <Check className="size-4" /> : <Copy className="size-4" />}</button>
        </div>
        {error && <p role="alert" className="text-error">{error}</p>}
        {list?.length === 0 && <p className="text-base-content/60">{m.settings_host_none()}</p>}
        {list && list.length > 0 && (
          <ul className="rounded-box border border-base-300">
            {list.map((c) => (
              <li key={c.client} className="flex items-center gap-3 p-3 not-last:border-b not-last:border-base-300">
                <span className="flex-1"><span className="font-medium">{c.name}</span> <span className="text-base-content/60">{m.settings_host_since({ date: new Date(c.since).toLocaleDateString(lang) })}</span></span>
                <button type="button" className="btn btn-sm" onClick={() => void drop(c.client)}>{m.disconnect()}</button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </details>
  );
}
