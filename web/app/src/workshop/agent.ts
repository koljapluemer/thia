import { INSTALL_BRIDGE, bridgeBackend, httpBackend, ollamaBackend, type AgentBackend } from '@gestalts/workshop';
import { AGENT_NODE, OLLAMA_NODE } from '../nodes';

/**
 * Who works on a draft with the teacher, whatever its kind: the server's agent (on our API key, within the school's
 * budget), or the claude CLI on this computer, through the claude bridge (`mise run claude-bridge`), which costs no API
 * tokens; or, experimental, a local Ollama model through the Ollama bridge (`mise run ollama-bridge`). Kept in this
 * browser, since the bridges are this computer's.
 */
export type AgentChoice = { agent: 'server' | 'cli' | 'ollama'; node: string; ollamaNode: string };

const KEY = 'teacher:agent';
export const DEFAULT_NODE: string = AGENT_NODE;
export const DEFAULT_OLLAMA_NODE: string = OLLAMA_NODE;
export const START = INSTALL_BRIDGE;

export function loadChoice(): AgentChoice {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<AgentChoice> | null;
    const address = (a: unknown, fallback: string) => (typeof a === 'string' && a ? a : fallback);
    if (v && (v.agent === 'server' || v.agent === 'cli' || v.agent === 'ollama')) {
      return { agent: v.agent, node: address(v.node, DEFAULT_NODE), ollamaNode: address(v.ollamaNode, DEFAULT_OLLAMA_NODE) };
    }
  } catch { /* the default */ }
  return { agent: 'server', node: DEFAULT_NODE, ollamaNode: DEFAULT_OLLAMA_NODE };
}

export function saveChoice(c: AgentChoice) {
  try { localStorage.setItem(KEY, JSON.stringify(c)); } catch { /* for this visit only */ }
}

/** An http(s) address without a path, or why not. */
export function nodeProblem(url: string, example: string = DEFAULT_NODE): string | undefined {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'an http:// address';
    if (u.pathname !== '/' || u.search || u.hash) return `the bridge’s address only, like ${example}`;
  } catch {
    return `an address like ${example}`;
  }
  return undefined;
}

export function cliAgent(node: string): ReturnType<typeof bridgeBackend> {
  return bridgeBackend(node);
}

export function backendFor(choice: AgentChoice, draft: string): AgentBackend {
  if (choice.agent === 'cli') return cliAgent(choice.node);
  if (choice.agent === 'ollama') return ollamaBackend(choice.ollamaNode);
  return httpBackend(`/api/drafts/${draft}/agent`, { id: 'teacher-server', label: 'Claude' });
}
