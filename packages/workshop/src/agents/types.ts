import type { ViewError } from '@gestalts/view';
import type { AgentKind } from './kinds';
import type { ToolContent } from './tools';

/**
 * What a workshop asks of an agent, whatever runs it (the claude CLI through the Claude bridge, the server).
 * The agent sees a draft as files ([`filesOf`](../draft.ts)) and returns the files it changed; the browser turns them
 * into ymls and writes them, so no agent needs access to any.
 */
export type TurnRequest = {
  /** what the draft is: a view (the default) or a visualization; it says what the agent is given (`kinds.ts`) */
  kind?: AgentKind;
  /** the draft's id (lowercase letters, digits and -) */
  view: string;
  /** this backend's conversation to continue, from an earlier `done` */
  session?: string;
  message: string;
  /** the draft as files, by path: a view's `view.tsx`, `view.json`, `gestalts/<name>@<N>.yml`, `data/<id>.yml`; a viz's `viz.ts`, `package.json` */
  files: Record<string, string>;
  /** files the agent reads and can't change, as base64 (a viz's `files/<label>`) */
  binary?: Record<string, string>;
  /** the brief kept with the draft, which the agent sees as SPEC.md */
  spec?: string;
  /** the gestalts the app has (`name@N`), which the view may read and write besides its own */
  gestalts: string[];
  /** what the preview reported since the last turn, and what couldn't be saved of the last one */
  diagnostics: Diagnostic[];
  /** the answer to the question the conversation waits on (`message` may be empty then) */
  answer?: Answer;
  /** the page's record of this turn (`runs/`), for a backend to name what it keeps of its own after */
  run?: string;
};

export type CompleteRequest = { view: string; system: string; prompt: string };

/** One question of an `ask` card (`agent-template/ask.json`). */
export type Question = {
  question: string;
  header: string;
  multiSelect?: boolean;
  options: { label: string; description: string; recommended?: boolean; preview?: string }[];
};

/** By question: the options picked, and what was written besides or instead. */
export type Answers = Record<string, string>;
export type Answer = { id: string; answers: Answers };

/** A question a conversation waits on, kept with the draft: answered with a turn of that session. */
export type OpenQuestion = { session: string; id: string; questions: Question[] };

/** An error from the preview, or a file of the last turn the repo refused (`save`). */
export type Diagnostic = { kind: ViewError['kind'] | 'save'; message: string; stack?: string; at: string };

/**
 * One request to a model, as far as the backend knows it: every field is optional, and a backend that knows none
 * sends none. `billing`: what it costs: API tokens paid for, a subscription's (notional), or nothing.
 */
export type Usage = {
  model?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** thinking tokens, when counted apart from `output` */
  reasoning?: number;
  /** the provider's own time for the request */
  ms?: number;
  billing?: 'api' | 'subscription' | 'free';
  /** only when the provider itself says what this request cost */
  costUsd?: number;
};

/**
 * What a turn says as it goes. A backend sends what it can: `text`, `tool`, `files` and `done` are the conversation;
 * `usage`, `tool_result`, `throttle` and `trace` are for the record of the turn (`runs/`), which the chat doesn't show.
 */
export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; summary: string }
  /** the files the turn changed; `null`: deleted */
  | { type: 'files'; files: Record<string, string | null> }
  /**
   * The agent asks. With `reply`, the turn waits for it (the Claude bridge, while the run lasts); without, the turn
   * ends here and the answer is the next turn's (`TurnRequest.answer`).
   */
  | { type: 'ask'; id: string; questions: Question[]; reply?: (answers: Answers) => void }
  /** `waiting`: the turn ended on a question; `outcome`: how the backend's own run ended, when it knows */
  | { type: 'done'; session?: string; waiting?: boolean; outcome?: 'completed' | 'failed' | 'cancelled'; exitCode?: number }
  | { type: 'error'; message: string }
  | ({ type: 'usage' } & Usage)
  /** how a tool call came out: whoever ran it (the page, a bridge, the server) */
  | { type: 'tool_result'; name: string; ok: boolean; ms?: number; content?: ToolContent[] }
  /** a request the provider turned away for now (a rate limit, an overload), and how long it was left */
  | { type: 'throttle'; model?: string; status?: number; waitMs?: number; reason?: string }
  /** what the backend got from its provider, as it came: kept with the record, never read by the page */
  | { type: 'trace'; source: string; data: unknown };

export interface AgentBackend {
  /** recorded with its sessions, so it stays */
  id: string;
  label: string;
  /** whether it can take a turn now, else why not */
  available(): Promise<true | string>;
  /** when it isn't available until the person allows this site (the Claude bridge): asks, true when allowed */
  connect?(): Promise<true | string>;
  turn(req: TurnRequest, signal: AbortSignal): AsyncIterable<AgentEvent>;
  /**
   * One answer to `prompt` under `system`, without tools and at low effort, for a feature built on the agent (planning
   * a lesson): its text. `view` is the draft it's for. Throws with why, when there's no answer.
   */
  complete(req: CompleteRequest, signal: AbortSignal): Promise<string>;
  /** the question the draft's conversation waits on, if any: kept where the agent runs, so it's there on any device */
  open?(view: string): Promise<OpenQuestion | undefined>;
}
