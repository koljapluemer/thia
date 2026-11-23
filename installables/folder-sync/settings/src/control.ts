/**
 * The node this page is served by, through its `/control/*`: same-origin, so no token is needed.
 */
import type { LlmSettings, LlmSettingsChange } from '@gestalts/client';

export type PluginStatus = { id: string; version: string; state: 'stopped' | 'starting' | 'ready' | 'running' | 'error'; error?: string | null };

export type NodeStatus = {
  version: string;
  address: string;
  folder: { id: string; path: string } | null;
  clients: { origin: string; seconds_ago: number }[];
  plugins: PluginStatus[];
  uv: { state: 'locating' | 'downloading' } | { state: 'ready'; version: string } | { state: 'failed'; error: string };
  /** null: starting on login isn't available */
  autostart: boolean | null;
};

async function control<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`control/${path}`, init);
  if (!r.ok) throw new Error((await r.text()) || `${r.status} ${r.statusText}`);
  return (r.status === 204 ? undefined : await r.json()) as T;
}

const json = (body: unknown): RequestInit => ({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const node = {
  status: () => control<NodeStatus>('status'),
  /** the native folder picker; the status afterwards, whether or not one was picked */
  chooseFolder: () => control<NodeStatus>('choose-folder', { method: 'POST' }),
  reveal: () => control<void>('reveal', { method: 'POST' }),
  setAutostart: (on: boolean) => control<NodeStatus>('autostart', json({ on })),
  quit: () => control<void>('quit', { method: 'POST' }),
  /** the LLM providers views can ask (never their keys) */
  llmSettings: async (): Promise<LlmSettings> => {
    const r = await fetch('llm/settings');
    if (!r.ok) throw new Error((await r.text()) || `${r.status} ${r.statusText}`);
    return (await r.json()) as LlmSettings;
  },
  /** an absent field stays, a `key: null` clears that key */
  changeLlmSettings: (change: LlmSettingsChange) => control<LlmSettings>('llm/settings', json(change)),
};
