import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import type { LlmProvider, LlmProviderId, LlmSettings as Settings, LlmSettingsChange } from '@gestalts/client';
import { useLang, type Messages } from '@gestalts/i18n';
import { node } from './control';

const NAMES = (m: Messages): Record<LlmProviderId, string> => ({ gemini: 'Gemini', claude_cli: m.llm_claude_cli(), openai: 'OpenAI' });
const HINTS = (m: Messages): Record<LlmProviderId, string> => ({
  gemini: m.llm_hint_gemini(),
  claude_cli: m.llm_hint_claude_cli(),
  openai: m.llm_hint_openai(),
});

/**
 * The LLM providers views can ask, kept by the node: tried top to bottom, one that is rate-limited skipped for a
 * while. Keys go to the node and never come back to this page.
 */
export function LlmSettings() {
  const { m } = useLang();
  const [settings, setSettings] = useState<Settings>();
  const [error, setError] = useState<string>();
  useEffect(() => { node.llmSettings().then(setSettings, (e: unknown) => setError(String(e))); }, []);

  const change = (c: LlmSettingsChange) => {
    setError(undefined);
    node.changeLlmSettings(c).then(setSettings, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  const move = (id: LlmProviderId, by: number) => {
    if (!settings) return;
    const order = [...settings.order];
    const i = order.indexOf(id);
    const j = i + by;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    change({ order });
  };

  if (!settings) return error ? <p className="text-sm text-error">{error}</p> : <span className="loading loading-spinner loading-sm" />;
  const byId = new Map(settings.providers.map((p) => [p.id, p]));
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-base-content/70">{m.llm_about()}</p>
      {settings.order.map((id, i) => {
        const p = byId.get(id);
        return p && <Provider key={`${id}:${p.model}`} provider={p} first={i === 0} last={i === settings.order.length - 1} onMove={(by) => move(id, by)} onChange={change} />;
      })}
      {error && <p className="text-sm text-error">{error}</p>}
    </div>
  );
}

function Provider({ provider: p, first, last, onMove, onChange }: { provider: LlmProvider; first: boolean; last: boolean; onMove: (by: number) => void; onChange: (c: LlmSettingsChange) => void }) {
  const { m } = useLang();
  const name = NAMES(m)[p.id];
  const [key, setKey] = useState('');
  // the row is keyed by its saved model, so a change from elsewhere starts it afresh
  const [model, setModel] = useState(p.model);
  const keyed = p.id !== 'claude_cli';
  const saveModel = () => {
    if (model.trim() === p.model) return;
    const chosen = model.trim() || null;
    onChange(p.id === 'claude_cli' ? { claude_cli: { model: chosen } } : { [p.id]: { model: chosen } });
  };
  const status = !p.configured ? m.llm_not_set_up() : p.paused ?? (p.last_error ? m.llm_last_try({ error: p.last_error }) : m.llm_ready());
  return (
    <div className="flex flex-col gap-1.5 rounded-box border border-base-300 p-2">
      <div className="flex items-center gap-1">
        <span className="flex-1 text-sm font-semibold">{name}</span>
        <button type="button" className="btn btn-ghost btn-xs btn-square" disabled={first} title={m.llm_try_earlier()} aria-label={m.llm_try_earlier()} onClick={() => onMove(-1)}><ArrowUp className="size-3" /></button>
        <button type="button" className="btn btn-ghost btn-xs btn-square" disabled={last} title={m.llm_try_later()} aria-label={m.llm_try_later()} onClick={() => onMove(1)}><ArrowDown className="size-3" /></button>
      </div>
      <p className="text-xs text-base-content/60">{HINTS(m)[p.id]}</p>
      {keyed ? (
        <form className="flex gap-1" onSubmit={(e) => { e.preventDefault(); if (key.trim()) { onChange({ [p.id]: { key: key.trim() } }); setKey(''); } }}>
          <input type="password" className="input input-xs flex-1" placeholder={p.configured ? m.llm_key_saved() : m.llm_key()} value={key}
                 onChange={(e) => setKey(e.target.value)} aria-label={m.llm_key_of({ name })} autoComplete="off" />
          <button type="submit" className="btn btn-xs" disabled={!key.trim()}>{m.llm_save()}</button>
          {p.configured && <button type="button" className="btn btn-ghost btn-xs" onClick={() => onChange({ [p.id]: { key: null } })}>{m.llm_remove()}</button>}
        </form>
      ) : (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="toggle toggle-xs" checked={p.configured} onChange={(e) => onChange({ claude_cli: { enabled: e.target.checked } })} />
          {m.llm_use_cli()}
        </label>
      )}
      <input className="input input-xs" value={model} onChange={(e) => setModel(e.target.value)} onBlur={saveModel}
             onKeyDown={(e) => { if (e.key === 'Enter') saveModel(); }} aria-label={m.llm_model_of({ name })} title={m.llm_model()} />
      <p className={`text-xs ${p.configured && (p.paused || p.last_error) ? 'text-warning' : 'text-base-content/60'}`}>{status}</p>
    </div>
  );
}
