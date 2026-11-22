import { useEffect, useRef, useState } from 'react';
import type { ViewError } from '@gestalts/view';
import type { AgentBackend, Answer, Answers, Diagnostic, Question } from './agents/types';
import { AskCard } from './AskCard';
import type { Work } from './work';

/**
 * An `ask` card: `reply` while the turn waits on it (the bridge), else answered with the next turn. `answered`: what
 * was answered, or why it closed.
 */
type Ask = { who: 'ask'; id: string; questions: Question[]; reply?: (answers: Answers) => void; answered?: string };
type Line = { who: 'you' | 'agent' | 'tool' | 'error'; text: string } | { who: 'checked'; ok: boolean; text: string; detail?: string } | Ask;

/** A message the person can send with one click, as it is (a viz's *Build from the spec*). */
export type Action = { label: string; message: string };

/** a conversation is its backend's: another one can't continue it */
const sessionKey = (backend: string, view: string) => `workshop:session:${backend}:${view}`;
function savedSession(backend: string, view: string) { try { return localStorage.getItem(sessionKey(backend, view)) ?? undefined; } catch { return undefined; } }

/**
 * One conversation about one draft, of any kind (`work`). Each turn sends the draft as files, and saves what comes
 * back; then the kind may check what's there itself (`settle`). What couldn't be saved goes with the next message, as
 * the preview's errors do.
 */
export function Chat({ work, backend, errors, onTurnDone, suggestion, actions = [] }: {
  work: Work; backend: AgentBackend; errors: ViewError[]; onTurnDone: () => void;
  /** what the message box starts with, for the person to read and send */
  suggestion?: string;
  actions?: Action[];
}) {
  const [refused, setRefused] = useState<Diagnostic[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [text, setText] = useState(suggestion ?? '');
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState<string>();
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);

  const [checked, setChecked] = useState(0);
  useEffect(() => { void backend.available().then((a) => setUnavailable(a === true ? undefined : a)); }, [backend, busy, checked]);
  const connect = async () => {
    const r = await backend.connect?.();
    if (r !== undefined && r !== true) setUnavailable(r);
    else setChecked((n) => n + 1);
  };
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [lines]);

  // a question the conversation waits on is the draft's: shown wherever it's opened
  useEffect(() => {
    let live = true;
    void backend.open?.(work.id).then((q) => {
      if (!live || !q) return;
      try { localStorage.setItem(sessionKey(backend.id, work.id), q.session); } catch { /* answered as a new conversation */ }
      setLines((ls) => (ls.some((l) => l.who === 'ask' && l.id === q.id) ? ls : [...ls, { who: 'ask', id: q.id, questions: q.questions }]));
    });
    return () => { live = false; };
  }, [backend, work.id]);

  const say = (l: Line) => setLines((ls) => [...ls, l]);
  const close = (id: string, answered: string) => setLines((ls) => ls.map((l) => (l.who === 'ask' && l.id === id ? { ...l, reply: undefined, answered } : l)));
  /** the open card a turn would answer, if any */
  const waiting = lines.find((l): l is Ask => l.who === 'ask' && !l.answered && !l.reply);

  const answer = (card: Ask, answers: Answers) => {
    const shown = Object.entries(answers).map(([q, a]) => `${q} → ${a}`).join('\n');
    if (card.reply) {
      card.reply(answers);
      close(card.id, shown);
    } else {
      close(card.id, shown);
      void send({ id: card.id, answers }, shown);
    }
  };

  const send = async (reply?: Answer, shown?: string, said?: string) => {
    const message = reply ? '' : (said ?? text).trim();
    if ((!message && !reply) || busy) return;
    if (!reply) {
      if (said === undefined) setText('');
      // a message instead of an answer answers the card
      if (waiting) close(waiting.id, 'answered by your message');
      say({ who: 'you', text: message });
    } else if (shown) {
      say({ who: 'you', text: shown });
    }
    setBusy(true);
    const controller = new AbortController();
    abort.current = controller;
    let changed = false;
    try {
      const snap = await work.snapshot();
      const diagnostics: Diagnostic[] = [...refused, ...errors];
      setRefused([]);
      const req = { kind: work.kind, view: work.id, session: savedSession(backend.id, work.id), message, ...snap, diagnostics, answer: reply };
      for await (const e of backend.turn(req, controller.signal)) {
        if (e.type === 'text') say({ who: 'agent', text: e.text });
        else if (e.type === 'ask') say({ who: 'ask', id: e.id, questions: e.questions, reply: e.reply });
        else if (e.type === 'tool') say({ who: 'tool', text: `${e.name} ${e.summary}` });
        else if (e.type === 'error') say({ who: 'error', text: e.message });
        else if (e.type === 'files') {
          changed = true;
          const problems = await work.apply(e.files);
          if (problems.length) {
            const at = new Date().toISOString();
            problems.forEach((p) => say({ who: 'error', text: `not saved: ${p}` }));
            setRefused(problems.map((p) => ({ kind: 'save', message: p, at })));
          }
        } else if (e.session) {
          try { localStorage.setItem(sessionKey(backend.id, work.id), e.session); } catch { /* the next turn starts afresh */ }
        }
      }
      if (changed && work.settle && !controller.signal.aborted) {
        say({ who: 'tool', text: 'check what came back, here' });
        const r = await work.settle(backend.id);
        if (r) say({ who: 'checked', ...r });
      }
      onTurnDone();
    } catch (e) {
      say({ who: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      // a card the run waited on closes with it
      setLines((ls) => ls.map((l) => (l.who === 'ask' && l.reply && !l.answered ? { ...l, reply: undefined, answered: 'closed: the turn ended before it was answered' } : l)));
      setBusy(false);
      abort.current = null;
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-base-100">
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3 text-sm">
        {lines.map((l, i) => (l.who === 'ask'
          ? <AskCard key={`ask-${l.id}`} questions={l.questions} answered={l.answered} disabled={!l.reply && busy} onAnswer={(a) => answer(l, a)} />
          : l.who === 'checked'
          ? (
            <div key={i} className={l.ok ? 'text-success' : 'text-error'}>
              {l.text}
              {l.detail && <details><summary className="cursor-pointer text-xs text-base-content/60">The check</summary><pre className="overflow-x-auto text-xs text-base-content">{l.detail}</pre></details>}
            </div>
          )
          : <p key={i} className={`whitespace-pre-wrap ${l.who === 'you' ? 'font-semibold' : l.who === 'tool' ? 'font-mono text-xs text-base-content/50' : l.who === 'error' ? 'text-error' : ''}`}>{l.text}</p>
        ))}
        {busy && <span className="loading loading-dots loading-sm" />}
        <div ref={end} />
      </div>
      {unavailable && (
        <div role="status" className="flex items-center gap-2 px-3 text-xs text-warning">
          <span className="flex-1">{unavailable}</span>
          {backend.connect && <button type="button" className="btn btn-xs" onClick={() => void connect()}>Connect</button>}
          <button type="button" className="btn btn-xs btn-ghost" onClick={() => setChecked((n) => n + 1)}>Check again</button>
        </div>
      )}
      {errors.length + refused.length > 0 && <p role="status" className="px-3 text-xs text-error">{errors.length + refused.length} error(s) from the preview and saving go with your next message.</p>}
      {actions.length > 0 && !busy && (
        <div className="flex flex-wrap gap-1 px-2 pt-2">
          {actions.map((a) => <button key={a.label} type="button" className="btn btn-xs" disabled={Boolean(unavailable)} onClick={() => void send(undefined, undefined, a.message)}>{a.label}</button>)}
        </div>
      )}
      <div className="flex gap-2 border-t border-base-300 p-2">
        <textarea className="textarea textarea-sm min-w-0 flex-1" rows={2} placeholder={waiting ? 'Answer above, or write your answer here' : 'What should it do?'} value={text} onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
        {busy
          ? <button type="button" className="btn btn-sm" onClick={() => abort.current?.abort()}>Stop</button>
          : <button type="button" className="btn btn-sm btn-primary" disabled={!text.trim() || Boolean(unavailable)} onClick={() => void send()}>Send</button>}
      </div>
    </div>
  );
}
