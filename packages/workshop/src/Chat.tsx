import { useEffect, useRef, useState } from 'react';
import { useLang } from '@gestalts/i18n';
import type { ViewError } from '@gestalts/view';
import type { AgentBackend, Answers } from './agents/types';
import { AskCard } from './AskCard';
import { closeAsk, conversationKey, keepSession, onTurnDone as whenDone, rate, runTurn, say, showAsk, stop, useConversation, type Ask, type Rate } from './turns';
import type { Work } from './work';

/** A message the person can send with one click, as it is (a viz's *Build from the spec*). */
export type Action = { label: string; message: string };

/**
 * One conversation about one draft, of any kind (`work`), as `turns` keeps it: a turn runs on while the chat isn't
 * shown, and shows here again, still going, when it is.
 */
export function Chat({ work, backend, errors, onTurnDone, suggestion, actions = [] }: {
  work: Work; backend: AgentBackend; errors: ViewError[]; onTurnDone: () => void;
  /** what the message box starts with, for the person to read and send */
  suggestion?: string;
  actions?: Action[];
}) {
  const { m } = useLang();
  const key = conversationKey(backend.id, work.id);
  const { lines, busy, refused } = useConversation(key);
  const [text, setText] = useState(suggestion ?? '');
  const [unavailable, setUnavailable] = useState<string>();
  const end = useRef<HTMLDivElement>(null);

  const [checked, setChecked] = useState(0);
  useEffect(() => { void backend.available().then((a) => setUnavailable(a === true ? undefined : a)); }, [backend, busy, checked]);
  const connect = async () => {
    const r = await backend.connect?.();
    if (r !== undefined && r !== true) setUnavailable(r);
    else setChecked((n) => n + 1);
  };
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [lines]);
  // the pane showing it hears of a turn's end; none while it isn't shown
  const done = useRef(onTurnDone);
  useEffect(() => { done.current = onTurnDone; });
  useEffect(() => { whenDone(key, () => done.current()); return () => whenDone(key, undefined); }, [key]);

  // a question the conversation waits on is the draft's: shown wherever it's opened
  useEffect(() => {
    let live = true;
    void backend.open?.(work.id).then((q) => {
      if (!live || !q) return;
      keepSession(backend.id, work.id, q.session);
      showAsk(key, { who: 'ask', id: q.id, questions: q.questions });
    });
    return () => { live = false; };
  }, [backend, work.id, key]);

  /** the open card a turn would answer, if any */
  const waiting = lines.find((l): l is Ask => l.who === 'ask' && !l.answered && !l.closed && !l.reply);

  const answer = (card: Ask, answers: Answers) => {
    const shown = Object.entries(answers).map(([q, a]) => `${q} → ${a}`).join('\n');
    closeAsk(key, card.id, shown);
    if (card.reply) card.reply(answers);
    else if (!busy) {
      say(key, { who: 'you', text: shown });
      void runTurn({ work, backend, message: '', reply: { id: card.id, answers }, errors });
    }
  };

  const send = (said?: string) => {
    const message = (said ?? text).trim();
    if (!message || busy) return;
    if (said === undefined) setText('');
    // a message instead of an answer answers the card
    if (waiting) closeAsk(key, waiting.id, m.chat_answered_by_message());
    say(key, { who: 'you', text: message });
    void runTurn({ work, backend, message, errors });
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-base-100">
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3 text-sm">
        {lines.map((l, i) => (l.who === 'ask'
          ? <AskCard key={`ask-${l.id}`} questions={l.questions} answered={l.closed ? m.ask_closed() : l.answered} disabled={!l.reply && busy} onAnswer={(a) => answer(l, a)} />
          : l.who === 'rate'
          ? <Rating key={`rate-${l.run.id}`} line={l} onRate={(score, comment) => rate(key, l.run, score, comment)} />
          : l.who === 'checked'
          ? (
            <div key={i} className={l.ok ? 'text-success' : 'text-error'}>
              {l.ok ? m.chat_built() : m.chat_check_failed()}
              {l.detail && <details><summary className="cursor-pointer text-xs text-base-content/60">{m.chat_check()}</summary><pre className="overflow-x-auto text-xs text-base-content">{l.detail}</pre></details>}
            </div>
          )
          : l.who === 'checking'
          ? <p key={i} className="font-mono text-xs text-base-content/50">{m.chat_checking()}</p>
          : <p key={i} className={`whitespace-pre-wrap ${l.who === 'you' ? 'font-semibold' : l.who === 'tool' ? 'font-mono text-xs text-base-content/50' : l.who === 'error' || l.who === 'unsaved' ? 'text-error' : ''}`}>{l.who === 'unsaved' ? m.chat_unsaved({ problem: l.text }) : l.text}</p>
        ))}
        {busy && <span className="loading loading-dots loading-sm" />}
        <div ref={end} />
      </div>
      {unavailable && (
        <div role="status" className="flex items-center gap-2 px-3 text-xs text-warning">
          <span className="flex-1">{unavailable}</span>
          {backend.connect && <button type="button" className="btn btn-xs" onClick={() => void connect()}>{m.chat_connect()}</button>}
          <button type="button" className="btn btn-xs btn-ghost" onClick={() => setChecked((n) => n + 1)}>{m.chat_check_again()}</button>
        </div>
      )}
      {errors.length + refused.length > 0 && <p role="status" className="px-3 text-xs text-error">{m.chat_errors({ count: errors.length + refused.length })}</p>}
      {actions.length > 0 && !busy && (
        <div className="flex flex-wrap gap-1 px-2 pt-2">
          {actions.map((a) => <button key={a.label} type="button" className="btn btn-xs" disabled={Boolean(unavailable)} onClick={() => send(a.message)}>{a.label}</button>)}
        </div>
      )}
      <div className="flex gap-2 border-t border-base-300 p-2">
        <textarea className="textarea textarea-sm min-w-0 flex-1" rows={2} placeholder={waiting ? m.chat_answer_here() : m.chat_what()} value={text} onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
        {busy
          ? <button type="button" className="btn btn-sm" onClick={() => stop(key)}>{m.chat_stop()}</button>
          : <button type="button" className="btn btn-sm btn-primary" disabled={!text.trim() || Boolean(unavailable)} onClick={() => send()}>{m.chat_send()}</button>}
      </div>
    </div>
  );
}

const SCORES = [1, 2, 3, 4, 5];

/** After a turn: how good it was, 1 (bad) to 5 (good), and why, if the person likes; kept with the turn's record. */
function Rating({ line, onRate }: { line: Rate; onRate: (score: number, comment: string) => void }) {
  const { m } = useLang();
  const [editing, setEditing] = useState(line.score === undefined);
  const [score, setScore] = useState(line.score);
  const [comment, setComment] = useState(line.comment ?? '');
  if (!editing && line.score !== undefined) {
    return (
      <div className="flex items-center gap-2 text-base-content/60">
        <span>{line.comment ? m.chat_rated_why({ score: line.score, comment: line.comment }) : m.chat_rated({ score: line.score })}</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>{m.chat_change()}</button>
      </div>
    );
  }
  const send = () => {
    if (score === undefined) return;
    onRate(score, comment);
    setEditing(false);
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-base-content/60">
      <span>{m.chat_how_good()}</span>
      <span>{m.chat_bad()}</span>
      <div className="join" role="radiogroup">
        {SCORES.map((s) => (
          <input key={s} type="radio" className="join-item btn btn-sm" name={`rate-${line.run.id}`} aria-label={String(s)}
                 checked={score === s} onChange={() => setScore(s)} />
        ))}
      </div>
      <span>{m.chat_good()}</span>
      {score !== undefined && (
        <>
          <input type="text" className="input input-sm min-w-0 flex-1" placeholder={m.chat_why()} value={comment}
                 onChange={(e) => setComment(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') send(); }} />
          <button type="button" className="btn btn-sm" onClick={send}>{m.chat_send()}</button>
        </>
      )}
    </div>
  );
}
