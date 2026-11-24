import { useEffect, useMemo, useState } from 'react';
import type { Messages } from '@gestalts/i18n';
import { bridgeBackend, codexBackend, geminiBackend, httpBackend, ollamaBackend, useRunning, type AgentBackend } from '@gestalts/workshop';
import { AGENT_NODE, CODEX_NODE, OLLAMA_NODE } from '../nodes';

/**
 * Who works on a draft, whatever its kind: the server's agent (on our API key, within the account's budget); the
 * claude CLI on this computer, through the claude bridge (`mise run claude-bridge`), which costs no API tokens;
 * Codex CLI on this computer through the Codex bridge (`mise run codex-bridge`);
 * experimental, a local Ollama model through the Ollama bridge (`mise run ollama-bridge`); or Google's free Gemini
 * models on the person's own key, from this page. They're tried in the order set in Settings: a turn goes to the
 * first one switched on that's available. Kept in this browser, since the bridges and the key are this computer's.
 */
export type AgentId = 'server' | 'cli' | 'codex' | 'ollama' | 'gemini';
export const AGENTS: AgentId[] = ['server', 'cli', 'codex', 'ollama', 'gemini'];
export type AgentChoice = { order: { id: AgentId; on: boolean }[]; node: string; codexNode: string; ollamaNode: string; geminiKey: string };

const KEY = 'workshop:agent';
/** where it was kept before, read once when there's nothing under `KEY` */
const OLD_KEY = 'teacher:agent';
export const DEFAULT_NODE: string = AGENT_NODE;
export const DEFAULT_CODEX_NODE: string = CODEX_NODE;
export const DEFAULT_OLLAMA_NODE: string = OLLAMA_NODE;

const isAgent = (a: unknown): a is AgentId => AGENTS.includes(a as AgentId);

/** Every agent once, in the order given, those missing after them, switched off; the server's on if none is. */
function complete(order: { id: AgentId; on: boolean }[]): { id: AgentId; on: boolean }[] {
  const seen = order.filter((o, i) => order.findIndex((p) => p.id === o.id) === i);
  const all = [...seen, ...AGENTS.filter((a) => !seen.some((o) => o.id === a)).map((id) => ({ id, on: false }))];
  return all.some((o) => o.on) ? all : all.map((o) => (o.id === 'server' ? { ...o, on: true } : o));
}

export function loadChoice(): AgentChoice {
  const choice: AgentChoice = { order: complete([]), node: DEFAULT_NODE, codexNode: DEFAULT_CODEX_NODE, ollamaNode: DEFAULT_OLLAMA_NODE, geminiKey: '' };
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? localStorage.getItem(OLD_KEY) ?? 'null') as (Partial<AgentChoice> & { agent?: unknown }) | null;
    if (!v) return choice;
    const text = (a: unknown, fallback: string) => (typeof a === 'string' && a ? a : fallback);
    const order = Array.isArray(v.order)
      ? v.order.filter((o) => isAgent(o?.id)).map((o) => ({ id: o.id, on: o.on === true }))
      // before the list: one agent, picked
      : isAgent(v.agent) ? [{ id: v.agent, on: true }] : [];
    return { order: complete(order), node: text(v.node, DEFAULT_NODE), codexNode: text(v.codexNode, DEFAULT_CODEX_NODE), ollamaNode: text(v.ollamaNode, DEFAULT_OLLAMA_NODE), geminiKey: text(v.geminiKey, '') };
  } catch {
    return choice;
  }
}

export function saveChoice(c: AgentChoice) {
  try { localStorage.setItem(KEY, JSON.stringify(c)); localStorage.removeItem(OLD_KEY); } catch { /* for this visit only */ }
}

/** An http(s) address without a path, or why not, in `m`'s language. */
export function nodeProblem(m: Messages, url: string, example: string = DEFAULT_NODE): string | undefined {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return m.address_http();
    if (u.pathname !== '/' || u.search || u.hash) return m.address_only({ example });
  } catch {
    return m.address_like({ example });
  }
  return undefined;
}

export function cliAgent(node: string): ReturnType<typeof bridgeBackend> {
  return bridgeBackend(node);
}

// one per key: it keeps the conversations and which models are paused, for every draft
const geminis = new Map<string, AgentBackend>();
export function geminiAgent(key: string): AgentBackend {
  let b = geminis.get(key);
  if (!b) geminis.set(key, (b = geminiBackend(key)));
  return b;
}

export function backendOf(id: AgentId, choice: AgentChoice, draft: string): AgentBackend {
  if (id === 'cli') return cliAgent(choice.node);
  if (id === 'codex') return codexBackend(choice.codexNode);
  if (id === 'ollama') return ollamaBackend(choice.ollamaNode);
  if (id === 'gemini') return geminiAgent(choice.geminiKey);
  return httpBackend(`/api/drafts/${draft}/agent`, { id: 'server', label: 'Claude' });
}

/**
 * The agent for a draft: the first switched on that's available, asked again when a turn ends and when the window
 * comes back; while a turn runs, the one running it. None available: the first switched on, which says why not.
 */
export function usePickedBackend(choice: AgentChoice, draft: string): AgentBackend {
  const list = useMemo(() => choice.order.filter((o) => o.on).map((o) => backendOf(o.id, choice, draft)), [choice, draft]);
  const [picked, setPicked] = useState<string>();
  const running = useRunning(draft);
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    const again = () => setAsked((n) => n + 1);
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, []);
  useEffect(() => {
    if (running) return;
    let live = true;
    void (async () => {
      for (const b of list) {
        if ((await b.available()) === true) { if (live) setPicked(b.id); return; }
        if (!live) return;
      }
      if (live) setPicked(list[0]?.id);
    })();
    return () => { live = false; };
  }, [list, running, asked]);
  return list.find((b) => b.id === picked) ?? list[0] ?? backendOf('server', choice, draft);
}
