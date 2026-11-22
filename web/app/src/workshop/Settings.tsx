import { useEffect, useState, type FormEvent } from 'react';
import { X } from 'lucide-react';
import { INSTALL_OLLAMA_BRIDGE, ollamaBackend, type AgentBackend } from '@gestalts/workshop';
import { DEFAULT_NODE, DEFAULT_OLLAMA_NODE, START, cliAgent, nodeProblem, type AgentChoice } from './agent';

/** What the address field says for each bridge. */
type BridgeText = { name: string; placeholder: string; backend: (url: string) => AgentBackend & { connect(): Promise<true | string> }; ok: string; start: string };
const CLAUDE: BridgeText = { name: 'Claude bridge', placeholder: DEFAULT_NODE, backend: cliAgent, ok: 'The bridge is there, finds Claude Code, and lets this site use it.', start: START };
const OLLAMA: BridgeText = { name: 'Ollama bridge', placeholder: DEFAULT_OLLAMA_NODE, backend: ollamaBackend, ok: 'The bridge is there, Ollama has the model, and the bridge lets this site use it.', start: INSTALL_OLLAMA_BRIDGE };

/** This browser's settings: who makes views with you. */
export function Settings({ choice, onSave, onClose }: { choice: AgentChoice; onSave: (c: AgentChoice) => void; onClose: () => void }) {
  const [agent, setAgent] = useState(choice.agent);
  const [node, setNode] = useState(choice.node);
  const [ollamaNode, setOllamaNode] = useState(choice.ollamaNode);
  const problem = agent === 'cli' ? nodeProblem(node.trim()) : agent === 'ollama' ? nodeProblem(ollamaNode.trim(), DEFAULT_OLLAMA_NODE) : undefined;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (problem) return;
    const clean = (u: string) => u.trim().replace(/\/+$/, '');
    onSave({ agent, node: clean(node), ollamaNode: clean(ollamaNode) });
  };
  return (
    <dialog open className="modal modal-open" onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <form onSubmit={submit} className="modal-box flex max-w-lg flex-col gap-3 text-sm">
        <div className="flex items-center">
          <h2 className="flex-1 text-base font-semibold">Settings</h2>
          <button type="button" className="btn btn-ghost btn-sm btn-square" title="Close" onClick={onClose}><X className="size-4" /></button>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 font-medium">Who makes views and plans lessons with you</legend>
          <label className="flex items-start gap-2">
            <input type="radio" className="radio radio-sm mt-0.5" name="agent" checked={agent === 'server'} onChange={() => setAgent('server')} />
            <span>Claude, on this site<span className="block text-xs text-base-content/60">Within your school’s monthly budget.</span></span>
          </label>
          <label className="flex items-start gap-2">
            <input type="radio" className="radio radio-sm mt-0.5" name="agent" checked={agent === 'cli'} onChange={() => setAgent('cli')} />
            <span>Claude Code on this computer<span className="block text-xs text-base-content/60">The <code>claude</code> command you’re signed in to here, on your own plan, through the Claude bridge.</span></span>
          </label>
          <label className="flex items-start gap-2">
            <input type="radio" className="radio radio-sm mt-0.5" name="agent" checked={agent === 'ollama'} onChange={() => setAgent('ollama')} />
            <span>Ollama on this computer (experimental)<span className="block text-xs text-base-content/60">A local model, through the Ollama bridge. Free, and much weaker than Claude.</span></span>
          </label>
        </fieldset>
        {agent === 'cli' && <Node key="cli" bridge={CLAUDE} node={node} setNode={setNode} problem={problem} />}
        {agent === 'ollama' && <Node key="ollama" bridge={OLLAMA} node={ollamaNode} setNode={setOllamaNode} problem={problem} />}
        <div className="modal-action mt-1">
          <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-sm btn-primary" disabled={Boolean(problem)}>Save</button>
        </div>
      </form>
      <button type="button" className="modal-backdrop" aria-label="Close" onClick={onClose} />
    </dialog>
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
      {problem && <p className="text-xs text-error">{problem}</p>}
      {!problem && status === undefined && <p className="text-xs text-base-content/60"><span className="loading loading-spinner loading-xs" /> Asking the bridge…</p>}
      {status === true && <p className="text-xs text-success">{bridge.ok}</p>}
      {typeof status === 'string' && (
        <div role="status" className="flex items-center gap-2 text-xs text-warning">
          <span className="flex-1">{status}</span>
          <button type="button" className="btn btn-xs" onClick={() => void connect()}>Connect</button>
        </div>
      )}
      <p className="text-xs text-base-content/70">
        {bridge.start}. It asks you once, on this computer, whether this site may use it. Your browser may ask too, whether this
        site may use apps on this device.
      </p>
    </div>
  );
}
