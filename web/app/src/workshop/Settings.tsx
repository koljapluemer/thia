import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { useLang, type Messages } from '@gestalts/i18n';
import { GEMINI_KEY_PAGE, codexBackend, geminiBackend, ollamaBackend, type AgentBackend } from '@gestalts/workshop';
import { DEFAULT_CODEX_NODE, DEFAULT_NODE, DEFAULT_OLLAMA_NODE, cliAgent, nodeProblem, type AgentChoice, type AgentId } from './agent';

/** What the address field says for each bridge. */
type BridgeText = { name: string; placeholder: string; backend: (url: string) => AgentBackend & { connect(): Promise<true | string> }; ok: string; start: string };
const CLAUDE = (m: Messages): BridgeText => ({ name: m.claude_bridge(), placeholder: DEFAULT_NODE, backend: cliAgent, ok: m.claude_bridge_ok(), start: m.claude_bridge_start() });
const CODEX = (m: Messages): BridgeText => ({ name: m.codex_bridge(), placeholder: DEFAULT_CODEX_NODE, backend: codexBackend, ok: m.codex_bridge_ok(), start: m.codex_bridge_start() });
const OLLAMA = (m: Messages): BridgeText => ({ name: m.ollama_bridge(), placeholder: DEFAULT_OLLAMA_NODE, backend: ollamaBackend, ok: m.ollama_bridge_ok(), start: m.ollama_bridge_start() });

const TEXT = (m: Messages): Record<AgentId, { name: string; about: ReactNode }> => ({
  server: { name: m.agent_server(), about: m.agent_server_about() },
  cli: { name: m.agent_cli(), about: m.agent_cli_about({ command: 'claude' }) },
  codex: { name: m.agent_codex(), about: m.agent_codex_about({ command: 'codex' }) },
  ollama: { name: m.agent_ollama(), about: m.agent_ollama_about() },
  gemini: { name: m.agent_gemini(), about: m.agent_gemini_about() },
});

/** This browser's settings: who makes views with you, tried in order. */
export function Settings({ choice, onSave, onClose }: { choice: AgentChoice; onSave: (c: AgentChoice) => void; onClose: () => void }) {
  const { m } = useLang();
  const text = TEXT(m);
  const [order, setOrder] = useState(choice.order);
  const [node, setNode] = useState(choice.node);
  const [codexNode, setCodexNode] = useState(choice.codexNode);
  const [ollamaNode, setOllamaNode] = useState(choice.ollamaNode);
  const [geminiKey, setGeminiKey] = useState(choice.geminiKey);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);

  const on = (id: AgentId) => order.some((o) => o.id === id && o.on);
  const problems: Partial<Record<AgentId, string>> = {
    cli: on('cli') ? nodeProblem(m, node.trim()) : undefined,
    codex: on('codex') ? nodeProblem(m, codexNode.trim(), DEFAULT_CODEX_NODE) : undefined,
    ollama: on('ollama') ? nodeProblem(m, ollamaNode.trim(), DEFAULT_OLLAMA_NODE) : undefined,
    gemini: on('gemini') && !geminiKey.trim() ? m.gemini_key_missing() : undefined,
  };
  const blocked = !order.some((o) => o.on) || Object.values(problems).some(Boolean);
  const toggle = (id: AgentId) => setOrder((os) => os.map((o) => (o.id === id ? { ...o, on: !o.on } : o)));
  const move = (i: number, by: -1 | 1) => setOrder((os) => {
    const next = [...os];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    return next;
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (blocked) return;
    const clean = (u: string) => u.trim().replace(/\/+$/, '');
    onSave({ order, node: clean(node), codexNode: clean(codexNode), ollamaNode: clean(ollamaNode), geminiKey: geminiKey.trim() });
  };

  return (
    <dialog ref={dialog} className="modal" onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <form onSubmit={submit} className="modal-box flex max-h-[90dvh] max-w-2xl flex-col gap-0 p-0 text-sm">
        <div className="flex items-center gap-2 border-b border-base-300 px-5 py-3">
          <h2 className="flex-1 font-semibold">{m.settings()}</h2>
          <button type="button" className="btn btn-ghost btn-sm btn-square" title={m.close()} aria-label={m.close()} onClick={onClose}><X className="size-4" /></button>
        </div>
        <div className="flex flex-col gap-2 overflow-y-auto px-5 py-4">
          <h3 className="font-medium">{m.settings_agents()}</h3>
          <p className="text-base-content/60">{m.settings_agents_order()}</p>
          <ul className="rounded-box border border-base-300">
            {order.map((o, i) => (
              <li key={o.id} className="flex flex-col gap-2 p-3 not-last:border-b not-last:border-base-300">
                <div className="flex items-start gap-3">
                  <label className="flex flex-1 cursor-pointer items-start gap-3">
                    <input type="checkbox" className="toggle toggle-sm mt-0.5" checked={o.on} onChange={() => toggle(o.id)} />
                    <span><span className="font-medium">{text[o.id].name}</span><span className="block text-base-content/60">{text[o.id].about}</span></span>
                  </label>
                  <div className="flex flex-col">
                    <button type="button" className="btn btn-ghost btn-xs btn-square" title={m.try_earlier()} aria-label={m.try_earlier()} disabled={i === 0} onClick={() => move(i, -1)}><ChevronUp className="size-4" /></button>
                    <button type="button" className="btn btn-ghost btn-xs btn-square" title={m.try_later()} aria-label={m.try_later()} disabled={i === order.length - 1} onClick={() => move(i, 1)}><ChevronDown className="size-4" /></button>
                  </div>
                </div>
                {o.on && o.id === 'cli' && <Node bridge={CLAUDE(m)} node={node} setNode={setNode} problem={problems.cli} />}
                {o.on && o.id === 'codex' && <Node bridge={CODEX(m)} node={codexNode} setNode={setCodexNode} problem={problems.codex} />}
                {o.on && o.id === 'ollama' && <Node bridge={OLLAMA(m)} node={ollamaNode} setNode={setOllamaNode} problem={problems.ollama} />}
                {o.on && o.id === 'gemini' && <GeminiKey value={geminiKey} onChange={setGeminiKey} />}
              </li>
            ))}
          </ul>
          {!order.some((o) => o.on) && <p className="text-error">{m.settings_one_on()}</p>}
        </div>
        <div className="modal-action m-0 border-t border-base-300 px-5 py-3">
          <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>{m.cancel()}</button>
          <button type="submit" className="btn btn-sm btn-primary" disabled={blocked}>{m.save()}</button>
        </div>
      </form>
      <form method="dialog" className="modal-backdrop"><button type="button" aria-label={m.close()} onClick={onClose}>{m.close()}</button></form>
    </dialog>
  );
}

function GeminiKey({ value, onChange }: { value: string; onChange: (s: string) => void }) {
  const { m } = useLang();
  const [status, setStatus] = useState<{ key: string; text: string; ok: boolean } | 'asking'>();
  const key = value.trim();
  const check = async () => {
    setStatus('asking');
    // the key as typed, not yet saved: a backend of its own, which keeps no conversation
    const b = geminiBackend(key);
    const a = await b.available();
    if (a !== true) { setStatus({ key, text: a, ok: false }); return; }
    try {
      await b.complete({ view: 'settings', system: 'Answer with one word.', prompt: 'Say ok.' }, AbortSignal.timeout(30_000));
      setStatus({ key, text: m.gemini_answers(), ok: true });
    } catch (e) {
      setStatus({ key, text: e instanceof Error ? e.message : String(e), ok: false });
    }
  };
  const shown = status === 'asking' || status?.key === key ? status : undefined;
  return (
    <div className="flex flex-col gap-2 rounded-box bg-base-200 p-3">
      <label className="flex flex-col gap-1">{m.gemini_key()}
        <div className="flex gap-1">
          <input className="input input-sm min-w-0 flex-1 font-mono" type="password" autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} />
          <button type="button" className="btn btn-sm" disabled={!key || shown === 'asking'} onClick={() => void check()}>{m.check()}</button>
        </div>
      </label>
      {shown === 'asking' && <p className="text-base-content/60"><span className="loading loading-spinner loading-xs" /> {m.gemini_asking()}</p>}
      {shown && shown !== 'asking' && <p className={shown.ok ? 'text-success' : 'text-warning'}>{shown.text}</p>}
      <p className="text-base-content/70">
        {m.gemini_make()} <a className="link" href={GEMINI_KEY_PAGE} target="_blank" rel="noreferrer">{GEMINI_KEY_PAGE.replace(/^https:\/\//, '')}</a>
      </p>
    </div>
  );
}

function Node({ bridge, node, setNode, problem }: { bridge: BridgeText; node: string; setNode: (s: string) => void; problem?: string }) {
  const { m } = useLang();
  const url = node.trim();
  // asked again a moment after the address changes, and on "Check"; an answer counts for the question it answers
  const [asked, setAsked] = useState(0);
  const question = `${asked} ${url}`;
  const [answer, setAnswer] = useState<{ question: string; status: true | string }>();
  const status = answer?.question === question ? answer.status : undefined;
  useEffect(() => {
    if (problem) return;
    let live = true;
    const t = setTimeout(() => { void bridge.backend(url).available().then((a) => { if (live) setAnswer({ question, status: a }); }); }, 400);
    return () => { live = false; clearTimeout(t); };
  }, [bridge, url, problem, question]);
  const connect = async () => {
    const r = await bridge.backend(url).connect();
    if (r === true) setAsked((n) => n + 1);
    else setAnswer({ question, status: r });
  };
  return (
    <div className="flex flex-col gap-2 rounded-box bg-base-200 p-3">
      <label className="flex flex-col gap-1">{m.bridge_address({ bridge: bridge.name })}
        <div className="flex gap-1">
          <input className="input input-sm min-w-0 flex-1 font-mono" type="url" value={node} placeholder={bridge.placeholder} onChange={(e) => setNode(e.target.value)} />
          <button type="button" className="btn btn-sm" onClick={() => setAsked((n) => n + 1)}>{m.check()}</button>
        </div>
      </label>
      {problem && <p className="text-error">{problem}</p>}
      {!problem && status === undefined && <p className="text-base-content/60"><span className="loading loading-spinner loading-xs" /> {m.bridge_asking()}</p>}
      {status === true && <p className="text-success">{bridge.ok}</p>}
      {typeof status === 'string' && (
        <div role="status" className="flex items-center gap-2 text-warning">
          <span className="flex-1">{status}</span>
          <button type="button" className="btn btn-xs" onClick={() => void connect()}>{m.connect()}</button>
        </div>
      )}
      <p className="text-base-content/70">
        {m.bridge_asks({ start: bridge.start })}
      </p>
    </div>
  );
}
