import { useCallback, useEffect, useMemo, useState } from 'react';
import tailwind from '@tailwindcss/browser?raw';
import { registry } from 'virtual:gestalts-plugins/workshop';
import { registry as lessons } from 'virtual:gestalts-plugins/lessons';
import { RepoProvider, useHostQuery, useOpenRepo, type Repo } from '@gestalts/client';
import { SingleView, closedCsp } from '@gestalts/host';
import { useLang, type Messages } from '@gestalts/i18n';
import type { ViewError } from '@gestalts/view';
import { Preview, VIEW, asDraft } from '@gestalts/workshop';
import css from '../app.css?inline';
import { AreaLink, Areas } from '../router';
import * as api from '../workshop/api';

/**
 * The review queue: what the workshops offered for the public site. Each submission shows what it is, its files, and
 * itself running, from a read-only copy; accepting writes it into the repo checkout the server was started
 * with (as a plugin, or a vizint deck), to be checked and committed; rejecting sends the sender a note.
 */
export function Review() {
  const { m } = useLang();
  const [me, setMe] = useState<api.Me | null>();
  useEffect(() => { api.me().then(setMe, () => setMe(null)); }, []);
  return (
    <div className="flex h-dvh flex-col bg-base-200">
      <header className="navbar min-h-0 gap-3 border-b border-base-300 bg-base-100 px-4 py-1">
        <Areas />
        <span className="font-semibold">{m.area_review()}</span>
      </header>
      {me === undefined && <div className="flex justify-center p-8"><span className="loading loading-spinner" /></div>}
      {me === null && <p className="p-8">{m.sign_in_first()} <AreaLink path="/workshop" className="link">{m.area_workshop()}</AreaLink></p>}
      {me && !me.admin && <p className="p-8">{m.admins_only()}</p>}
      {me?.admin && <Queue />}
    </div>
  );
}

const BADGE = { pending: 'badge-warning', accepted: 'badge-success', rejected: 'badge-ghost' } as const;
const STATUS = (m: Messages, s: api.Submission['status']) => ({ pending: m.status_pending, accepted: m.status_accepted, rejected: m.status_rejected })[s]();

function Queue() {
  const { m, lang } = useLang();
  const [queue, setQueue] = useState<{ submissions: api.Submission[]; repo: string | null }>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [all, setAll] = useState(false);
  const reload = useCallback(() => { api.queue().then(setQueue, (e: unknown) => setError(e instanceof Error ? e.message : String(e))); }, []);
  useEffect(reload, [reload]);
  if (error) return <div role="alert" className="alert alert-error m-4">{error}</div>;
  if (!queue) return <div className="flex justify-center p-8"><span className="loading loading-spinner" /></div>;
  const shown = queue.submissions.filter((s) => all || s.status === 'pending');
  return (
    <div className="flex min-h-0 flex-1">
      <nav className="flex w-64 shrink-0 flex-col gap-1 overflow-y-auto border-e border-base-300 bg-base-100 p-2">
        <label className="label gap-2 px-2 text-xs"><input type="checkbox" className="toggle toggle-xs" checked={all} onChange={(e) => setAll(e.target.checked)} />{m.review_decided_too()}</label>
        <ul className="menu menu-sm w-full p-0">
          {shown.map((s) => (
            <li key={s.id}>
              <button type="button" className={s.id === selected ? 'menu-active' : ''} onClick={() => setSelected(s.id)}>
                <span className="flex min-w-0 flex-1 flex-col items-start">
                  <span className="w-full truncate">{s.title}</span>
                  <span className="text-xs text-base-content/50">{m.review_kind_date({ kind: s.kind === 'viz' ? m.kind_viz() : m.kind_view(), date: new Date(s.created).toLocaleDateString(lang) })}</span>
                </span>
                <span className={`badge badge-xs ${BADGE[s.status]}`}>{STATUS(m, s.status)}</span>
              </button>
            </li>
          ))}
        </ul>
        {!shown.length && <p className="p-2 text-sm text-base-content/60">{m.review_nothing()}</p>}
      </nav>
      <main className="min-w-0 flex-1 overflow-y-auto">
        {selected
          ? <Detail key={selected} id={selected} repo={queue.repo} onDecided={reload} />
          : <div className="flex h-full items-center justify-center text-base-content/60">{m.review_pick()}</div>}
      </main>
    </div>
  );
}

type Detailed = Awaited<ReturnType<typeof api.submission>>;

function Detail({ id, repo, onDecided }: { id: string; repo: string | null; onDecided: () => void }) {
  const { m, lang } = useLang();
  const [s, setS] = useState<Detailed>();
  const [error, setError] = useState<string>();
  useEffect(() => { api.submission(id).then(setS, (e: unknown) => setError(e instanceof Error ? e.message : String(e))); }, [id]);
  if (error) return <div role="alert" className="alert alert-error m-4">{error}</div>;
  if (!s) return <div className="flex justify-center p-8"><span className="loading loading-spinner" /></div>;
  return (
    <div className="flex flex-col gap-4 p-4">
      <section className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">{s.title}</h1>
        <p className="text-sm text-base-content/60">
          {(s.kind === 'viz' ? m.review_from_viz : m.review_from_view)({ email: s.email, source: s.source, time: new Date(s.created).toLocaleString(lang) })}
          {s.credit && <> {m.review_credit({ credit: s.credit })}</>}
        </p>
        <p className="whitespace-pre-wrap">{s.about}</p>
        {s.status !== 'pending' && (
          <p className="text-sm">
            {m.review_was({ status: STATUS(m, s.status), time: s.decided ? new Date(s.decided).toLocaleString(lang) : '' })}
            {s.promoted && <> {m.review_into({ path: s.promoted })}</>}
            {s.note && <> {m.review_note({ note: s.note })}</>}
          </p>
        )}
      </section>
      <section className="h-[32rem] overflow-hidden rounded-box border border-base-300 bg-base-100">
        <Live s={s} />
      </section>
      <section>
        <h2 className="mb-1 font-medium">{m.review_files()}</h2>
        {s.ymls.map((y) => (
          <details key={y.id} className="border-b border-base-300 py-1">
            <summary className="cursor-pointer font-mono text-sm">{y.id}</summary>
            <pre className="overflow-x-auto bg-base-100 p-2 text-xs">{y.text}</pre>
          </details>
        ))}
      </section>
      {s.status === 'pending' && <Decide s={s} repo={repo} onDecided={onDecided} />}
    </div>
  );
}

/** The submission running, from its snapshot mounted read-only in a folder of its own: trying it changes nothing. */
function Live({ s }: { s: Detailed }) {
  const source = useMemo(() => ({
    dir: `review-${s.id}`,
    decks: [{ source: `submission/${s.id}`, url: api.submissionDeck(s.id) }],
    gestalts: [...registry.gestalts, ...lessons.gestalts],
  }), [s.id]);
  const { repo, error } = useOpenRepo(source);
  if (error) return <div role="alert" className="alert alert-error m-4">{error}</div>;
  if (!repo) return <div className="flex justify-center p-8"><span className="loading loading-spinner" /></div>;
  return <RepoProvider repo={repo}>{s.kind === 'viz' ? <VizLive s={s} /> : <ViewLive repo={repo} />}</RepoProvider>;
}

const NO_NAVIGATION = () => {};

function VizLive({ s }: { s: Detailed }) {
  const viz = s.ymls.find((y) => /^gestalt: viz@1$/m.test(y.text))?.id;
  const params = useMemo((): Record<string, string> => (viz ? { viz } : {}), [viz]);
  return <SingleView registry={registry} css={css} view="vizint" params={params} onParams={NO_NAVIGATION} />;
}

function ViewLive({ repo }: { repo: Repo }) {
  const view = useHostQuery({ gestalt: VIEW, limit: 1 })[0];
  const draft = useMemo(() => (view ? asDraft(view) : null), [view]);
  const [errors, setErrors] = useState<ViewError[]>([]);
  const onError = useCallback((e: ViewError) => setErrors((es) => [...es, e].slice(-5)), []);
  const csp = useMemo(() => closedCsp({ scripts: [`${location.origin}/api/npm/`] }), []);
  if (!draft) return <div className="flex justify-center p-8"><span className="loading loading-spinner" /></div>;
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1"><Preview repo={repo} draft={draft} runtime={registry.runtime} css={css} tailwind={tailwind} onError={onError} resolveNpm={api.resolveNpm} csp={csp} /></div>
      {errors.length > 0 && <ul role="alert" className="max-h-24 overflow-y-auto border-t border-base-300 p-2 text-xs text-error">{errors.map((e, i) => <li key={i}>{e.message}</li>)}</ul>}
    </div>
  );
}

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function Decide({ s, repo, onDecided }: { s: Detailed; repo: string | null; onDecided: () => void }) {
  const { m } = useLang();
  const [t, setT] = useState<api.Target>(s.proposed);
  const [about, setAbout] = useState(Object.keys(s.proposed.concepts ?? {}).join(', '));
  const names = about.split(',').map((n) => n.trim()).filter(Boolean);
  // what an earlier acceptance weighted stays; a new name counts fully
  const concepts = Object.fromEntries(names.map((n) => [n, s.proposed.concepts?.[n] ?? 1]));
  const drafted = useMemo(() => s.ymls.flatMap((y) => {
    if (!/^gestalt:\s*concept@/m.test(y.text)) return [];
    const name = /^name:\s*['"]?(.*?)['"]?\s*$/m.exec(y.text)?.[1];
    return name ? [name] : [];
  }).sort(), [s.ymls]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [done, setDone] = useState<api.Promoted | 'rejected'>();
  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setProblems([]);
    try { await f(); onDecided(); } catch (e) {
      setProblems(e instanceof api.ApiError && e.problems.length ? e.problems : [e instanceof Error ? e.message : String(e)]);
    } finally { setBusy(false); }
  };
  const field = (k: 'plugin' | 'package' | 'deck', label: string) => (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-base-content/70">{label}</span>
      <input className={`input input-sm font-mono ${NAME.test(t[k] ?? '') ? '' : 'input-error'}`} value={t[k] ?? ''} onChange={(e) => setT({ ...t, [k]: e.target.value })} />
    </label>
  );
  const valid = [t.deck, ...(s.kind === 'view' ? [t.plugin, t.package] : [])].every((x) => NAME.test(x ?? '')) && names.length > 0;

  if (done === 'rejected') return <p className="text-sm">{m.review_rejected()}</p>;
  if (done) {
    return (
      <section className="flex flex-col gap-2 rounded-box border border-success p-3 text-sm">
        <p>{m.review_accepted_into({ path: done.at })}</p>
        <pre className="overflow-x-auto bg-base-100 p-2 text-xs">{done.next.join('\n')}</pre>
        {done.warnings.map((w) => <p key={w} className="text-warning">{w}</p>)}
        <details><summary className="cursor-pointer text-xs">{m.review_written({ count: done.written.length })}</summary><pre className="overflow-x-auto text-xs">{done.written.join('\n')}</pre></details>
      </section>
    );
  }
  return (
    <section className="grid gap-4 md:grid-cols-2">
      <div className="flex flex-col gap-2 rounded-box border border-base-300 bg-base-100 p-3 text-sm">
        <h2 className="font-medium">{m.accept()}</h2>
        {s.kind === 'view'
          ? <>{field('plugin', m.review_as_plugin())}{field('package', m.review_as_package())}{field('deck', m.review_as_deck())}</>
          : field('deck', m.review_as_viz_deck())}
        <label className="flex flex-col gap-1">
          <span className="text-xs text-base-content/70">{m.review_concepts()}</span>
          <input className={`input input-sm ${names.length ? '' : 'input-error'}`} placeholder={m.review_concepts_example()} value={about} onChange={(e) => setAbout(e.target.value)} />
          {drafted.length > 0 && <span className="text-xs text-base-content/60">{m.review_own_concepts({ list: drafted.join(', ') })}</span>}
        </label>
        {repo
          ? <p className="text-xs text-base-content/60">{m.review_into_checkout({ path: repo })}</p>
          : <p className="text-xs text-warning">{m.review_no_checkout()}</p>}
        <button type="button" className="btn btn-sm btn-primary" disabled={busy || !repo || !valid} onClick={() => void run(async () => setDone(await api.accept(s.id, { ...t, concepts })))}>{m.accept()}</button>
      </div>
      <div className="flex flex-col gap-2 rounded-box border border-base-300 bg-base-100 p-3 text-sm">
        <h2 className="font-medium">{m.reject()}</h2>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-base-content/70">{m.review_why()}</span>
          <textarea className="textarea textarea-sm" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <button type="button" className="btn btn-sm" disabled={busy || !note.trim()} onClick={() => void run(async () => { await api.reject(s.id, note); setDone('rejected'); })}>{m.reject()}</button>
      </div>
      {problems.length > 0 && (
        <div role="alert" className="text-sm text-error md:col-span-2">
          <ul className="list-disc ps-5">{problems.map((x) => <li key={x}>{x}</li>)}</ul>
        </div>
      )}
    </section>
  );
}
