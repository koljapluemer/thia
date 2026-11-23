import { useSyncExternalStore } from 'react';
import type { ViewError } from '@gestalts/view';
import { contracts } from './agents/kinds';
import type { AgentBackend, Answer, Answers, Diagnostic, Question } from './agents/types';
import { NO_RUN, newRun, type Run, type RunEvent } from './runs';
import type { Work } from './work';

/**
 * An `ask` card: `reply` while the turn waits on it (the bridge), else answered with the next turn. `answered`: what
 * was answered, or why it closed.
 */
export type Ask = { who: 'ask'; id: string; questions: Question[]; reply?: (answers: Answers) => void; answered?: string };
/** How good a turn was, as the person says after it (1–5), kept with the turn's record. */
export type Rate = { who: 'rate'; run: Run; score?: number; comment?: string };
export type Line = { who: 'you' | 'agent' | 'tool' | 'error'; text: string } | { who: 'checked'; ok: boolean; text: string; detail?: string } | Ask | Rate;

/** One conversation about one draft, with one backend: what was said, and whether a turn is running. */
export type Conversation = { lines: Line[]; busy: boolean; refused: Diagnostic[] };

type Entry = { draft: string; state: Conversation; controller?: AbortController; onDone?: () => void; listeners: Set<() => void> };

/**
 * Conversations live here, not in the chat that shows one: a turn is its draft's, so it runs on while another draft is
 * open, and opening its draft again shows it as it goes, with its Stop and its questions. Only a reload ends one (the
 * bridge stops claude when the page goes).
 */
const entries = new Map<string, Entry>();
const anyChange = new Set<() => void>();
const EMPTY: Conversation = { lines: [], busy: false, refused: [] };

export const conversationKey = (backend: string, draft: string) => `${backend}\n${draft}`;

function entry(key: string): Entry {
  let e = entries.get(key);
  if (!e) {
    e = { draft: key.slice(key.indexOf('\n') + 1), state: EMPTY, listeners: new Set() };
    entries.set(key, e);
  }
  return e;
}

function update(key: string, f: (c: Conversation) => Partial<Conversation>) {
  const e = entry(key);
  e.state = { ...e.state, ...f(e.state) };
  e.listeners.forEach((l) => l());
  anyChange.forEach((l) => l());
}

export const say = (key: string, l: Line) => update(key, (c) => ({ lines: [...c.lines, l] }));
/** shows a question the conversation waits on, once */
export const showAsk = (key: string, a: Ask) => update(key, (c) => (c.lines.some((l) => l.who === 'ask' && l.id === a.id) ? {} : { lines: [...c.lines, a] }));
export const closeAsk = (key: string, id: string, answered: string) =>
  update(key, (c) => ({ lines: c.lines.map((l) => (l.who === 'ask' && l.id === id ? { ...l, reply: undefined, answered } : l)) }));
export const stop = (key: string) => entries.get(key)?.controller?.abort();

/** Records how good the turn of `run` was; a later rating of the same turn replaces it. */
export function rate(key: string, run: Run, score: number, comment: string) {
  const text = comment.trim();
  run.add({ type: 'rating', score, ...(text ? { comment: text } : {}) });
  void run.flush();
  update(key, (c) => ({ lines: c.lines.map((l) => (l.who === 'rate' && l.run === run ? { ...l, score, comment: text } : l)) }));
}

/** What the chat showing `key` does when a turn there ends (its pane's refresh); none while no chat shows it. */
export function onTurnDone(key: string, f: (() => void) | undefined) {
  entry(key).onDone = f;
}

/** The conversation as it is now (`useConversation` keeps a chat current with it). */
export const conversationOf = (key: string): Conversation => entries.get(key)?.state ?? EMPTY;

export function useConversation(key: string): Conversation {
  return useSyncExternalStore(
    (l) => { const e = entry(key); e.listeners.add(l); return () => { e.listeners.delete(l); }; },
    () => entries.get(key)?.state ?? EMPTY,
  );
}

/** Whether a turn runs on `draft`, with any backend: for showing it where the draft is listed. */
export function useRunning(draft: string): boolean {
  return useSyncExternalStore(
    (l) => { anyChange.add(l); return () => { anyChange.delete(l); }; },
    () => [...entries.values()].some((e) => e.draft === draft && e.state.busy),
  );
}

const sessionKey = (backend: string, view: string) => `workshop:session:${backend}:${view}`;
function savedSession(backend: string, view: string) { try { return localStorage.getItem(sessionKey(backend, view)) ?? undefined; } catch { return undefined; } }
export function keepSession(backend: string, view: string, session: string) {
  try { localStorage.setItem(sessionKey(backend, view), session); } catch { /* the next turn starts afresh */ }
}

/**
 * One turn: sends the draft as files and saves what comes back; then the kind may check what's there itself (`settle`).
 * What couldn't be saved goes with the next message, as the preview's `errors` do. Nothing happens while one runs.
 */
export async function runTurn({ work, backend, message, reply, errors }: {
  work: Work; backend: AgentBackend; message: string; reply?: Answer; errors: ViewError[];
}) {
  const key = conversationKey(backend.id, work.id);
  const e = entry(key);
  if (e.state.busy) return;
  const controller = new AbortController();
  e.controller = controller;
  const refused = e.state.refused;
  update(key, () => ({ busy: true, refused: [] }));
  let changed = false;
  let run: Run = NO_RUN;
  let failed = false;
  let waiting = false;
  try {
    const snap = await work.snapshot();
    const diagnostics: Diagnostic[] = [...refused, ...errors];
    const session = savedSession(backend.id, work.id);
    const template = await contracts[work.kind].template().catch(() => undefined);
    run = newRun({
      type: 'start', purpose: 'turn', draft: work.id, kind: work.kind, backend: { id: backend.id, label: backend.label },
      message, session, answer: reply, diagnostics, gestalts: snap.gestalts,
      inputs: { files: snap.files, binary: snap.binary, spec: snap.spec, template: template?.files },
    });
    const req = { kind: work.kind, view: work.id, session, message, ...snap, diagnostics, answer: reply, run: run.id || undefined };
    for await (const ev of backend.turn(req, controller.signal)) {
      // the record has every event, as it came (but no function: an ask's reply is the page's)
      run.add((ev.type === 'ask' ? { type: 'ask', id: ev.id, questions: ev.questions } : ev) as RunEvent);
      if (ev.type === 'text') say(key, { who: 'agent', text: ev.text });
      else if (ev.type === 'ask') say(key, { who: 'ask', id: ev.id, questions: ev.questions, reply: ev.reply });
      else if (ev.type === 'tool') say(key, { who: 'tool', text: `${ev.name} ${ev.summary}` });
      else if (ev.type === 'error') { failed = true; say(key, { who: 'error', text: ev.message }); }
      else if (ev.type === 'files') {
        changed = true;
        const problems = await work.apply(ev.files);
        if (problems.length) {
          run.add({ type: 'saved', problems });
          const at = new Date().toISOString();
          problems.forEach((p) => say(key, { who: 'error', text: `not saved: ${p}` }));
          update(key, (c) => ({ refused: [...c.refused, ...problems.map((p): Diagnostic => ({ kind: 'save', message: p, at }))] }));
        }
      } else if (ev.type === 'done') {
        if (ev.session) keepSession(backend.id, work.id, ev.session);
        if (ev.waiting) waiting = true;
        if (ev.outcome === 'failed') failed = true;
      }
    }
    if (changed && work.settle && !controller.signal.aborted) {
      say(key, { who: 'tool', text: 'check what came back, here' });
      const r = await work.settle(backend.id);
      if (r) { say(key, { who: 'checked', ...r }); run.add({ type: 'settled', ...r }); }
    }
    e.onDone?.();
  } catch (err) {
    failed = true;
    const text = err instanceof Error ? err.message : String(err);
    run.add({ type: 'error', message: text });
    say(key, { who: 'error', text });
  } finally {
    e.controller = undefined;
    if (run !== NO_RUN) {
      run.add({ type: 'end', outcome: controller.signal.aborted ? 'stopped' : failed ? 'failed' : 'completed', waiting });
      void run.end();
      say(key, { who: 'rate', run });
    }
    // a card the run waited on closes with it
    update(key, (c) => ({
      busy: false,
      lines: c.lines.map((l) => (l.who === 'ask' && l.reply && !l.answered ? { ...l, reply: undefined, answered: 'closed: the turn ended before it was answered' } : l)),
    }));
  }
}
