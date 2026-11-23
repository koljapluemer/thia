import { contracts, systemOf } from './kinds';
import { timed, type AgentTool } from './tools';
import type { AgentBackend, AgentEvent, Answers, CompleteRequest, Question, TurnRequest } from './types';

/**
 * The claude CLI on this computer, through the Claude bridge (`installables/claude-bridge`): a site the person allowed
 * sends the files, the instructions and its tools; the bridge runs `claude -p` on them and hands every tool call back
 * here. This page answers them, so the tools are the app's whatever model runs.
 */

export type BridgeStatus = { app: string; version: string; claude: { found: boolean; path?: string; version?: string }; paired: boolean };

/** One turn, as the bridge takes it. */
export type BridgeStart = {
  /** the workspace's name (a draft's id): a session resumes only in its own */
  workspace: string;
  session?: string;
  prompt: string;
  system?: string;
  files: Record<string, string>;
  /** bytes, as base64 */
  binary?: Record<string, string>;
  /** which paths are the draft (a regex for the whole path): what tools see and what comes back */
  keep: string;
  model?: string;
  maxBudgetUsd?: number;
  /** how hard Claude thinks: low, medium, high, xhigh or max */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** the page's record of this turn, for the bridge's own messages about it */
  run?: string;
};

/** What the bridge says: the same events a turn has anywhere (a bridge sends what it can of them). */
export type BridgeEvent = AgentEvent;

export const INSTALL_BRIDGE = 'Install the Claude bridge and Claude Code on this computer, then start the bridge';

const tokenKey = (url: string) => `claude-bridge:token:${url.replace(/\/+$/, '')}`;
function token(url: string): string | undefined {
  try { return localStorage.getItem(tokenKey(url)) ?? undefined; } catch { return undefined; }
}

const base = (url: string) => url.replace(/\/+$/, '');

/** What the bridge at `url` says, or why there's no answer. `name` and `install` word it (the Claude bridge's by default). */
export async function bridgeStatus<S = BridgeStatus>(url: string, name = 'Claude bridge', install = INSTALL_BRIDGE): Promise<S | string> {
  try {
    const t = token(url);
    const r = await fetch(`${base(url)}/status`, { headers: t ? { Authorization: `Bearer ${t}` } : {} });
    if (!r.ok) return `the ${name} at ${base(url)} answered ${r.status}`;
    return (await r.json()) as S;
  } catch {
    return `no ${name} answers at ${base(url)}. ${install}.`;
  }
}

/** Asks the bridge to let this site use it; the person decides in a dialog on their computer. */
export async function pairBridge(url: string, name = 'Claude bridge'): Promise<true | string> {
  try {
    const r = await fetch(`${base(url)}/pair`, { method: 'POST' });
    const body = (await r.json().catch(() => ({}))) as { token?: string; error?: string };
    if (!r.ok || !body.token) return body.error ?? `the ${name} answered ${r.status}`;
    try { localStorage.setItem(tokenKey(url), body.token); } catch { return 'this browser keeps nothing: allow storage for this site'; }
    return true;
  } catch {
    return `no ${name} answers at ${base(url)}`;
  }
}

/** Whether a turn can run now, else why not. */
export async function bridgeAvailable(url: string): Promise<true | string> {
  const s = await bridgeStatus(url);
  if (typeof s === 'string') return s;
  if (!s.claude.found) return 'the Claude bridge runs, but finds no Claude Code on this computer: install it and sign in once in a terminal';
  if (!s.paired) return 'not connected to the Claude bridge yet';
  return true;
}

/**
 * Runs one turn on the bridge at `url`, answering its tool calls with `tools`. Aborting `signal` stops claude; what
 * it changed until then still comes back.
 */
export async function* runOnBridge(url: string, start: BridgeStart, tools: AgentTool[], signal: AbortSignal, name = 'Claude bridge'): AsyncIterable<BridgeEvent> {
  const t = token(url);
  const ws = new WebSocket(`${base(url).replace(/^http/, 'ws')}/runs${t ? `?token=${encodeURIComponent(t)}` : ''}`);
  const queue: BridgeEvent[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  const push = (e: BridgeEvent) => { queue.push(e); wake?.(); };
  const byName = new Map(tools.map((x) => [x.name, x]));

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'start', ...start, tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }));
  });
  ws.addEventListener('message', (m) => {
    let e: { type: string; id?: string; name?: string; input?: unknown; files?: Record<string, string> };
    try { e = JSON.parse(String(m.data)); } catch { return; }
    if (e.type === 'tool_call') {
      const tool = byName.get(e.name ?? '');
      const show = (questions: Question[], reply: (answers: Answers) => void) => push({ type: 'ask', id: e.id ?? '', questions, reply });
      const answer = timed(e.name ?? '', tool
        ? tool.run(e.input, e.files ?? {}, show)
        : Promise.resolve({ content: [{ type: 'text' as const, text: `no tool ${e.name}` }], isError: true }));
      void answer.then(({ result, event }) => {
        push(event);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'tool_result', id: e.id, ...result }));
      });
    } else {
      push(e as BridgeEvent);
    }
  });
  ws.addEventListener('close', () => { closed = true; wake?.(); });
  ws.addEventListener('error', () => {
    if (queue.length === 0) push({ type: 'error', message: `cannot reach the ${name} at ${base(url)}, or it doesn't allow this site` });
  });
  const cancel = () => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'cancel' })); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      while (queue.length) {
        const e = queue.shift()!;
        yield e;
        if (e.type === 'done') return;
      }
      if (closed) {
        yield { type: 'done' };
        return;
      }
      await new Promise<void>((r) => { wake = r; });
      wake = undefined;
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  }
}

/** What a view's draft is, as files; everything else in a workspace is the template's or scratch. */
export const VIEW_FILES = contracts.view.keep;

export function errorsFile(diagnostics: TurnRequest['diagnostics']): string {
  const lines = ['# Errors the preview reported since the last turn', ''];
  for (const d of diagnostics) lines.push(`## ${d.kind}: ${d.message}`, '', '```', (d.stack ?? '').trim(), '```', '');
  return lines.join('\n');
}

/** Who runs on a bridge, and how the page tells whether it can. */
export type OnBridge = { id: string; label: string; name: string; available: () => Promise<true | string> };

/**
 * A backend on the bridge at `url` (claude-bridge's protocol), for any kind of draft: what it's told, given and checked
 * with is the kind's (`kinds.ts`), the same as the server's agent gets. `connect` asks the bridge to allow this site.
 */
export function onBridge(url: string, who: OnBridge): AgentBackend & { connect(): Promise<true | string> } {
  return {
    id: who.id,
    label: who.label,
    available: who.available,
    connect: () => pairBridge(url, who.name),
    async *turn(req: TurnRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
      const kind = contracts[req.kind ?? 'view'];
      const template = await kind.template();
      const files: Record<string, string> = { ...template.files, ...req.files };
      if (req.spec?.trim()) files['SPEC.md'] = `${req.spec.trim()}\n`;
      let prompt = req.message;
      if (req.diagnostics.length) {
        files['runtime-errors.md'] = errorsFile(req.diagnostics);
        prompt += `\n\n(The preview reported ${req.diagnostics.length} error(s) since the last turn: see runtime-errors.md.)`;
      }
      const start: BridgeStart = {
        workspace: req.view, session: req.session, prompt, files, binary: { ...template.binary, ...req.binary }, keep: kind.keep,
        system: systemOf(req.kind ?? 'view'), run: req.run,
      };
      yield* runOnBridge(url, start, kind.tools(req), signal, who.name);
    },
    async complete(req: CompleteRequest, signal: AbortSignal): Promise<string> {
      // a run with nothing in its workspace, no tools of the page's and nothing kept: only what it says
      const start: BridgeStart = { workspace: req.view, prompt: req.prompt, system: req.system, files: {}, keep: 'nothing-is-kept', effort: 'low' };
      let text = '';
      for await (const e of runOnBridge(url, start, [], signal, who.name)) {
        if (e.type === 'text') text += e.text;
        else if (e.type === 'error') throw new Error(e.message);
      }
      return text;
    },
  };
}

/** The claude CLI through the Claude bridge at `url`. */
export function bridgeBackend(url: string): AgentBackend & { connect(): Promise<true | string> } {
  return onBridge(url, { id: 'claude-cli', label: 'Claude (Claude Code on this computer)', name: 'Claude bridge', available: () => bridgeAvailable(url) });
}
