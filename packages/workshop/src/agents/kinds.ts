import view from '../../agent-template/kinds/view.json';
import viz from '../../agent-template/kinds/viz.json';
import { fromBase64 } from '../base64';
import { viewTemplate, vizTemplate, type Template } from './template';
import { askTool, viewCheckTool, vizCheckTool, type AgentTool } from './tools';
import type { TurnRequest } from './types';

/**
 * What an agent is told and given for each kind of draft it works on, whichever backend runs it. `system` and `keep`
 * come from `agent-template/kinds/<kind>.json`, which the server's agent reads too; `brief.md` goes before them.
 */
export type AgentKind = 'view' | 'viz';

export type KindContract = {
  /** what the agent is told about this kind, after the brief */
  system: string;
  /** which paths are the draft (a regex for the whole path): what a turn may change */
  keep: string;
  template(): Promise<Template>;
  /** the page's tools for a turn on this kind */
  tools(req: TurnRequest): AgentTool[];
};

const briefs = import.meta.glob('../../agent-template/brief.md', { query: '?raw', import: 'default', eager: true });
/** Who the agent makes things for, before any kind's contract (`agent-template/brief.md`). */
export const BRIEF = String(Object.values(briefs)[0] ?? '').trim();

const bytesOf = (binary: Record<string, string> = {}) => Object.fromEntries(Object.entries(binary).map(([p, b]) => [p, fromBase64(b)]));

export const contracts: Record<AgentKind, KindContract> = {
  view: { ...view, template: viewTemplate, tools: (req) => [viewCheckTool(req.gestalts), askTool()] },
  viz: { ...viz, template: vizTemplate, tools: (req) => [vizCheckTool(bytesOf(req.binary)), askTool()] },
};

/** The system text for a kind: the brief, then the kind's. */
export const systemOf = (kind: AgentKind) => `${BRIEF}\n\n${contracts[kind].system}`;
