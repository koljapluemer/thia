import { bridgeStatus, onBridge } from './bridge';
import type { AgentBackend } from './types';

export type CodexStatus = { app: string; version: string; codex: { found: boolean; path?: string; version?: string }; paired: boolean };

export const INSTALL_CODEX_BRIDGE = 'Install the Codex bridge and Codex CLI on this computer, sign in, then start the bridge';
const NAME = 'Codex bridge';
const TOKEN_PREFIX = 'codex-bridge';

export async function codexAvailable(url: string): Promise<true | string> {
  const s = await bridgeStatus<CodexStatus>(url, NAME, INSTALL_CODEX_BRIDGE, TOKEN_PREFIX);
  if (typeof s === 'string') return s;
  if (!s.codex.found) return 'the Codex bridge runs, but finds no Codex CLI on this computer: install it and sign in once in a terminal';
  if (!s.paired) return 'not connected to the Codex bridge yet';
  return true;
}

export function codexBackend(url: string): AgentBackend & { connect(): Promise<true | string> } {
  return onBridge(url, {
    id: 'codex-cli',
    label: 'Codex on this computer',
    name: NAME,
    tokenPrefix: TOKEN_PREFIX,
    available: () => codexAvailable(url),
  });
}
