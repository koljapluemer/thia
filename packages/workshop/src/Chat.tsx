import { useEffect, useRef, useState } from 'react';
import type { ViewError } from '@gestalts/view';
import type { AgentBackend, Answers } from './agents/types';
import { AskCard } from './AskCard';
import { closeAsk, conversationKey, keepSession, onTurnDone as whenDone, runTurn, say, showAsk, stop, useConversation, type Ask } from './turns';
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
  const waiting = lines.find((l): l is Ask => l.who === 'ask' && !l.answered && !l.reply);

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
    if (waiting) closeAsk(key, waiting.id, 'answered by your message');
    say(key, { who: 'you', text: message });
    void runTurn({ work, backend, message, errors });
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
          {actions.map((a) => <button key={a.label} type="button" className="btn btn-xs" disabled={Boolean(unavailable)} onClick={() => send(a.message)}>{a.label}</button>)}
        </div>
      )}
      <div className="flex gap-2 border-t border-base-300 p-2">
        <textarea className="textarea textarea-sm min-w-0 flex-1" rows={2} placeholder={waiting ? 'Answer above, or write your answer here' : 'What should it do?'} value={text} onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
        {busy
          ? <button type="button" className="btn btn-sm" onClick={() => stop(key)}>Stop</button>
          : <button type="button" className="btn btn-sm btn-primary" disabled={!text.trim() || Boolean(unavailable)} onClick={() => send()}>Send</button>}
      </div>
    </div>
  );
}
