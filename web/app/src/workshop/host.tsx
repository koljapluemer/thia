import { useCallback, useEffect, useState } from 'react';
import { CircleCheck, CircleX, MessageSquare } from 'lucide-react';
import type { Repo } from '@gestalts/client';
import { useLang } from '@gestalts/i18n';
import type { ViewError } from '@gestalts/view';
import * as api from './api';

/** How often the page asks whether a chat app works on the draft, and syncs while one does. */
const ASK_EVERY = 5_000;
const SYNC_WHILE_ACTIVE = 2_000;
const SYNC_OTHERWISE = 15_000;

/**
 * A chat app's work on the draft (over MCP), as the workshop follows it: while one works on it, the draft syncs every
 * few seconds, so the preview shows each change soon; its requests are listed to rate.
 */
export function useHostWork(repo: Repo, id: string): { active: boolean; runs: api.HostRun[]; reload: () => void } {
  const [state, setState] = useState<{ active: boolean; runs: api.HostRun[] }>({ active: false, runs: [] });
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    let live = true;
    const ask = () => api.draftHost(id).then((s) => { if (live) setState(s); }, () => { /* asked again soon */ });
    void ask();
    const t = setInterval(() => void ask(), ASK_EVERY);
    return () => { live = false; clearInterval(t); };
  }, [id, asked]);
  useEffect(() => {
    repo.pollEvery(state.active ? SYNC_WHILE_ACTIVE : SYNC_OTHERWISE);
  }, [repo, state.active]);
  useEffect(() => () => repo.pollEvery(SYNC_OTHERWISE), [repo]);
  return { ...state, reload: () => setAsked((n) => n + 1) };
}

/**
 * What the preview reports for the source it runs, sent to the server a moment after it settles (none: it runs fine),
 * for a chat app's `check`. Reports of an earlier source don't count once the source changed.
 */
export function useReportPreview(id: string, source: string | undefined): (e: ViewError) => void {
  const [reported, setReported] = useState<{ source?: string; errors: ViewError[] }>({ errors: [] });
  const onError = useCallback((e: ViewError) => setReported((r) => (r.source === source
    ? { source, errors: [...r.errors, e].slice(-20) }
    : { source, errors: [e] })), [source]);
  const body = JSON.stringify(reported.source === source ? reported.errors : []);
  useEffect(() => {
    if (source === undefined) return;
    const t = setTimeout(() => void api.reportPreview(id, JSON.parse(body) as ViewError[]).catch(() => { /* the next report says it */ }), 1500);
    return () => clearTimeout(t);
  }, [id, source, body]);
  return onError;
}

/** A chat app's requests on the draft, the latest first, each to rate; and whether it's at work now. */
export function HostRuns({ active, runs, reload }: { active: boolean; runs: api.HostRun[]; reload: () => void }) {
  const { m } = useLang();
  if (!active && runs.length === 0) return null;
  return (
    <div className="flex shrink-0 flex-col gap-2 border-b border-base-300 p-3 text-sm">
      <div className="flex items-center gap-2 font-medium">
        <MessageSquare className="size-4" /> <span className="flex-1">{m.host_runs()}</span>
        {active && <span className="flex items-center gap-1 text-base-content/60"><span className="loading loading-dots loading-xs" /> {m.host_active()}</span>}
      </div>
      <ul className="flex max-h-48 flex-col gap-2 overflow-y-auto">
        {runs.slice(0, 5).map((r) => <HostRun key={r.id} run={r} onRated={reload} />)}
      </ul>
    </div>
  );
}

function HostRun({ run, onRated }: { run: api.HostRun; onRated: () => void }) {
  const { m } = useLang();
  const check = run.checkOk === true
    ? <span className="flex items-center gap-1 text-success"><CircleCheck className="size-3" /> {m.host_check_ok()}</span>
    : run.checkOk === false
      ? <span className="flex items-center gap-1 text-error"><CircleX className="size-3" /> {m.host_check_failed()}</span>
      : <span>{m.host_unchecked()}</span>;
  return (
    <li className="flex flex-col gap-1 rounded-box bg-base-200 p-2">
      <span className="line-clamp-2">{run.message ?? m.host_no_request()}</span>
      <span className="flex flex-wrap items-center gap-x-3 text-xs text-base-content/60">
        <span>{m.host_files({ count: run.filesChanged })}</span>
        {check}
      </span>
      {!run.open && <RateRun run={run} onRated={onRated} />}
    </li>
  );
}

const SCORES = [1, 2, 3, 4, 5];

/** How good it was, 1 (bad) to 5 (good), and why if the person likes, as a turn of the workshop's own chat is rated. */
function RateRun({ run, onRated }: { run: api.HostRun; onRated: () => void }) {
  const { m } = useLang();
  const [editing, setEditing] = useState(false);
  const [score, setScore] = useState<number | undefined>(run.rating ?? undefined);
  const [comment, setComment] = useState(run.comment ?? '');
  if (run.rating !== null && !editing) {
    return (
      <div className="flex items-center gap-2 text-xs text-base-content/60">
        <span>{run.comment ? m.chat_rated_why({ score: run.rating, comment: run.comment }) : m.chat_rated({ score: run.rating })}</span>
        <button type="button" className="btn btn-ghost btn-xs" onClick={() => setEditing(true)}>{m.chat_change()}</button>
      </div>
    );
  }
  const send = async () => {
    if (score === undefined) return;
    await api.rateRun(run.id, score, comment).catch(() => { /* shown unrated still */ });
    setEditing(false);
    onRated();
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-base-content/60">
      <span>{m.chat_how_good()}</span>
      <span>{m.chat_bad()}</span>
      <div className="join" role="radiogroup">
        {SCORES.map((s) => (
          <input key={s} type="radio" className="join-item btn btn-xs" name={`rate-${run.id}`} aria-label={String(s)} checked={score === s} onChange={() => setScore(s)} />
        ))}
      </div>
      <span>{m.chat_good()}</span>
      {score !== undefined && (
        <>
          <input type="text" className="input input-xs min-w-0 flex-1" placeholder={m.chat_why()} value={comment}
                 onChange={(e) => setComment(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void send(); }} />
          <button type="button" className="btn btn-xs" onClick={() => void send()}>{m.chat_send()}</button>
        </>
      )}
    </div>
  );
}
