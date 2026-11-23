import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { GEMINI_KEY_PAGE, INSTALL_OLLAMA_BRIDGE, geminiBackend, ollamaBackend, type AgentBackend } from '@gestalts/workshop';
import { DEFAULT_NODE, DEFAULT_OLLAMA_NODE, START, cliAgent, nodeProblem, type AgentChoice, type AgentId } from './agent';

/** What the address field says for each bridge. */
type BridgeText = { name: string; placeholder: string; backend: (url: string) => AgentBackend & { connect(): Promise<true | string> }; ok: string; start: string };
const CLAUDE: BridgeText = { name: 'Claude bridge', placeholder: DEFAULT_NODE, backend: cliAgent, ok: 'The bridge is there, finds Claude Code, and lets this site use it.', start: START };
const OLLAMA: BridgeText = { name: 'Ollama bridge', placeholder: DEFAULT_OLLAMA_NODE, backend: ollamaBackend, ok: 'The bridge is there, Ollama has the model, and the bridge lets this site use it.', start: INSTALL_OLLAMA_BRIDGE };

const TEXT: Record<AgentId, { name: string; about: ReactNode }> = {
  server: { name: 'Claude, on this site', about: 'Within your school’s monthly budget.' },
  cli: { name: 'Claude Code on this computer', about: <>The <code>claude</code> command you’re signed in to here, on your own plan, through the Claude bridge.</> },
  ollama: { name: 'Ollama on this computer (experimental)', about: 'A local model, through the Ollama bridge. Free, and much weaker than Claude.' },
  gemini: { name: 'Gemini, free tier', about: 'Google’s free models on your own AI Studio key, called from this browser; the conversation stays in this tab. Google may use what’s sent on the free tier to improve its products.' },
};

/** This browser's settings: who makes views with you, tried in order. */
export function Settings({ choice, onSave, onClose }: { choice: AgentChoice; onSave: (c: AgentChoice) => void; onClose: () => void }) {
  const [order, setOrder] = useState(choice.order);
  const [node, setNode] = useState(choice.node);
  const [ollamaNode, setOllamaNode] = useState(choice.ollamaNode);
  const [geminiKey, setGeminiKey] = useState(choice.geminiKey);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);

  const on = (id: AgentId) => order.some((o) => o.id === id && o.on);
  const problems: Partial<Record<AgentId, string>> = {
    cli: on('cli') ? nodeProblem(node.trim()) : undefined,
    ollama: on('ollama') ? nodeProblem(ollamaNode.trim(), DEFAULT_OLLAMA_NODE) : undefined,
    gemini: on('gemini') && !geminiKey.trim() ? 'your Gemini API key' : undefined,
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
    onSave({ order, node: clean(node), ollamaNode: clean(ollamaNode), geminiKey: geminiKey.trim() });
  };

  return (
    <dialog ref={dialog} className="modal" onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <form onSubmit={submit} className="modal-box flex max-h-[90dvh] max-w-2xl flex-col gap-0 p-0 text-sm">
        <div className="flex items-center gap-2 border-b border-base-300 px-5 py-3">
          <h2 className="flex-1 font-semibold">Settings</h2>
          <button type="button" className="btn btn-ghost btn-sm btn-square" title="Close" onClick={onClose}><X className="size-4" /></button>
        </div>
        <div className="flex flex-col gap-2 overflow-y-auto px-5 py-4">
          <h3 className="font-medium">Who makes views and plans lessons with you</h3>
          <p className="text-base-content/60">Tried from the top: the first one switched on that’s ready takes the turn.</p>
          <ul className="rounded-box border border-base-300">
            {order.map((o, i) => (
              <li key={o.id} className="flex flex-col gap-2 p-3 not-last:border-b not-last:border-base-300">
                <div className="flex items-start gap-3">
                  <label className="flex flex-1 cursor-pointer items-start gap-3">
                    <input type="checkbox" className="toggle toggle-sm mt-0.5" checked={o.on} onChange={() => toggle(o.id)} />
                    <span><span className="font-medium">{TEXT[o.id].name}</span><span className="block text-base-content/60">{TEXT[o.id].about}</span></span>
                  </label>
                  <div className="flex flex-col">
                    <button type="button" className="btn btn-ghost btn-xs btn-square" title="Try earlier" disabled={i === 0} onClick={() => move(i, -1)}><ChevronUp className="size-4" /></button>
                    <button type="button" className="btn btn-ghost btn-xs btn-square" title="Try later" disabled={i === order.length - 1} onClick={() => move(i, 1)}><ChevronDown className="size-4" /></button>
                  </div>
                </div>
                {o.on && o.id === 'cli' && <Node bridge={CLAUDE} node={node} setNode={setNode} problem={problems.cli} />}
                {o.on && o.id === 'ollama' && <Node bridge={OLLAMA} node={ollamaNode} setNode={setOllamaNode} problem={problems.ollama} />}
                {o.on && o.id === 'gemini' && <GeminiKey value={geminiKey} onChange={setGeminiKey} />}
              </li>
            ))}
          </ul>
          {!order.some((o) => o.on) && <p className="text-error">Switch on at least one.</p>}
        </div>
        <div className="modal-action m-0 border-t border-base-300 px-5 py-3">
          <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-sm btn-primary" disabled={blocked}>Save</button>
        </div>
      </form>
      <form method="dialog" className="modal-backdrop"><button type="button" aria-label="Close" onClick={onClose}>close</button></form>
    </dialog>
  );
}

function GeminiKey({ value, onChange }: { value: string; onChange: (s: string) => void }) {
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
      setStatus({ key, text: 'Gemini answers on this key.', ok: true });
    } catch (e) {
      setStatus({ key, text: e instanceof Error ? e.message : String(e), ok: false });
    }
  };
  const shown = status === 'asking' || status?.key === key ? status : undefined;
  return (
    <div className="flex flex-col gap-2 rounded-box bg-base-200 p-3">
      <label className="flex flex-col gap-1">Your Gemini API key
        <div className="flex gap-1">
          <input className="input input-sm min-w-0 flex-1 font-mono" type="password" autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} />
          <button type="button" className="btn btn-sm" disabled={!key || shown === 'asking'} onClick={() => void check()}>Check</button>
        </div>
      </label>
      {shown === 'asking' && <p className="text-base-content/60"><span className="loading loading-spinner loading-xs" /> Asking Gemini…</p>}
      {shown && shown !== 'asking' && <p className={shown.ok ? 'text-success' : 'text-warning'}>{shown.text}</p>}
      <p className="text-base-content/70">
        Make one, free, at <a className="link" href={GEMINI_KEY_PAGE} target="_blank" rel="noreferrer">aistudio.google.com/apikey</a>. It’s kept in
        this browser and sent only to Google.
      </p>
    </div>
  );
}

function Node({ bridge, node, setNode, problem }: { bridge: BridgeText; node: string; setNode: (s: string) => void; problem?: string }) {
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
      <label className="flex flex-col gap-1">The {bridge.name}’s address
        <div className="flex gap-1">
          <input className="input input-sm min-w-0 flex-1 font-mono" type="url" value={node} placeholder={bridge.placeholder} onChange={(e) => setNode(e.target.value)} />
          <button type="button" className="btn btn-sm" onClick={() => setAsked((n) => n + 1)}>Check</button>
        </div>
      </label>
      {problem && <p className="text-error">{problem}</p>}
      {!problem && status === undefined && <p className="text-base-content/60"><span className="loading loading-spinner loading-xs" /> Asking the bridge…</p>}
      {status === true && <p className="text-success">{bridge.ok}</p>}
      {typeof status === 'string' && (
        <div role="status" className="flex items-center gap-2 text-warning">
          <span className="flex-1">{status}</span>
          <button type="button" className="btn btn-xs" onClick={() => void connect()}>Connect</button>
        </div>
      )}
      <p className="text-base-content/70">
        {bridge.start}. It asks you once, on this computer, whether this site may use it. Your browser may ask too, whether this
        site may use apps on this device.
      </p>
    </div>
  );
}
