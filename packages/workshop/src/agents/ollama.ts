import { bridgeStatus, onBridge } from './bridge';
import type { AgentBackend } from './types';

/**
 * A local Ollama model, through the Ollama bridge (`installables/ollama-bridge`, experimental): the same protocol as
 * the Claude bridge, so the same files, instructions and tools; the bridge asks the model with tools in a loop.
 */

export type OllamaStatus = { app: string; version: string; ollama: { found: boolean; host: string; model: string; hasModel: boolean }; paired: boolean };

export const INSTALL_OLLAMA_BRIDGE = 'Install Ollama and start the Ollama bridge on this computer (mise run ollama-bridge)';
const NAME = 'Ollama bridge';

/** Whether a turn can run now, else why not. */
export async function ollamaAvailable(url: string): Promise<true | string> {
  const s = await bridgeStatus<OllamaStatus>(url, NAME, INSTALL_OLLAMA_BRIDGE);
  if (typeof s === 'string') return s;
  if (!s.ollama.found) return `the Ollama bridge runs, but no Ollama answers at ${s.ollama.host}: start it`;
  if (!s.ollama.hasModel) return `Ollama doesn't have ${s.ollama.model} yet: run \`ollama pull ${s.ollama.model}\``;
  if (!s.paired) return 'not connected to the Ollama bridge yet';
  return true;
}

export function ollamaBackend(url: string): AgentBackend & { connect(): Promise<true | string> } {
  return onBridge(url, { id: 'ollama', label: 'Ollama on this computer (experimental)', name: NAME, available: () => ollamaAvailable(url) });
}
