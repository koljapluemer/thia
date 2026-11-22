import { useEffect, useRef, useState } from 'react';
import type { Repo } from '@gestalts/client';
import type { ViewError } from '@gestalts/view';
import type { AgentBackend, Answer, Answers, Diagnostic, Question } from './agents/types';
import { AskCard } from './AskCard';
import { applyFiles, filesOf, loadMembers, saveDraft, type Draft } from './draft';

/**
 * An `ask` card: `reply` while the turn waits on it (the bridge), else answered with the next turn. `answered`: what
 * was answered, or why it closed.
 */
type Ask = { who: 'ask'; id: string; questions: Question[]; reply?: (answers: Answers) => void; answered?: string };
type Line = { who: 'you' | 'agent' | 'tool' | 'error'; text: string } | Ask;

/** a conversation is its backend's: another one can't continue it */
const sessionKey = (backend: string, view: string) => `workshop:session:${backend}:${view}`;
function savedSession(backend: string, view: string) { try { return localStorage.getItem(sessionKey(backend, view)) ?? undefined; } catch { return undefined; } }

/**
 * One conversation about one draft. Each turn sends the draft as files, and saves what comes back. What couldn't be
 * saved goes with the next message, as the preview's errors do. `runtime` is recorded on the draft with each save.
 */
export function Chat({ repo, draft, backend, runtime, errors, onTurnDone, suggestion }: {
  repo: Repo; draft: Draft; backend: AgentBackend; runtime?: string; errors: ViewError[]; onTurnDone: () => void;
  /** what the message box starts with (a brief the draft was made from), for the person to read and send */
  suggestion?: string;
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
    void backend.open?.(draft.id).then((q) => {
      if (!live || !q) return;
      try { localStorage.setItem(sessionKey(backend.id, draft.id), q.session); } catch { /* answered as a new conversation */ }
      setLines((ls) => (ls.some((l) => l.who === 'ask' && l.id === q.id) ? ls : [...ls, { who: 'ask', id: q.id, questions: q.questions }]));
    });
    return () => { live = false; };
  }, [backend, draft.id]);

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

  const send = async (reply?: Answer, shown?: string) => {
    const message = reply ? '' : text.trim();
    if ((!message && !reply) || busy) return;
    if (!reply) {
      setText('');
      // a message instead of an answer answers the card
      if (waiting) close(waiting.id, 'answered by your message');
      say({ who: 'you', text: message });
    } else if (shown) {
      say({ who: 'you', text: shown });
    }
    setBusy(true);
    const controller = new AbortController();
    abort.current = controller;
    let current = draft;
    try {
      let members = await loadMembers(repo, current);
      const gestalts = (await repo.gestalts()).map((g) => `${g.name}@${g.version}`).filter((g) => !g.startsWith(`${current.package}/`));
      const diagnostics: Diagnostic[] = [...refused, ...errors];
      setRefused([]);
      for await (const e of backend.turn({ view: draft.id, session: savedSession(backend.id, draft.id), message, files: filesOf(current, members), gestalts, diagnostics, answer: reply }, controller.signal)) {
        if (e.type === 'text') say({ who: 'agent', text: e.text });
        else if (e.type === 'ask') say({ who: 'ask', id: e.id, questions: e.questions, reply: e.reply });
        else if (e.type === 'tool') say({ who: 'tool', text: `${e.name} ${e.summary}` });
        else if (e.type === 'error') say({ who: 'error', text: e.message });
        else if (e.type === 'files') {
          const saved = await saveDraft(repo, applyFiles(current, members, e.files), runtime);
          current = saved.draft;
          members = await loadMembers(repo, current);
          if (saved.problems.length) {
            const at = new Date().toISOString();
            saved.problems.forEach((p) => say({ who: 'error', text: `not saved: ${p}` }));
            setRefused(saved.problems.map((p) => ({ kind: 'save', message: p, at })));
          }
        } else if (e.session) {
          try { localStorage.setItem(sessionKey(backend.id, draft.id), e.session); } catch { /* the next turn starts afresh */ }
        }
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
