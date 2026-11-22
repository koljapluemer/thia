import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Copy, Download, Link2Off, Send, Trash2 } from 'lucide-react';
import { registry as teacher } from 'virtual:gestalts-plugins/teacher';
import { registry as workshop } from 'virtual:gestalts-plugins/workshop';
import { useConnector, useHostQuery, type Repo } from '@gestalts/client';
import { closedCsp, deckSources, type Registry } from '@gestalts/host';
import type { DeckSource } from '@gestalts/client';
import type { ViewError } from '@gestalts/view';
import { Chat, Preview, VIEWS, asDraft, createDraft } from '@gestalts/workshop';
import tailwind from '@tailwindcss/browser?raw';
import css from '../app.css?inline';
import { backendFor, type AgentChoice } from './agent';
import * as api from './api';
import { OpenDraft } from './open';
import { SubmitMenu } from './submit';

/**
 * Where a view's draft is tried out: what it would go out in. A teacher's is a lesson's (the `teacher` distribution:
 * the core's gestalts and the lesson models, nothing else). A maintainer's is the public site's learning views'
 * (the workshop distribution, with the plugins' decks beside it); what they make can still only be published as a
 * lesson within the lesson models, which the server checks.
 */
const contextOf = (me: api.Me): { registry: Registry; source: { gestalts: string[]; decks?: DeckSource[] } } => (me.maintainer
  ? { registry: workshop, source: { gestalts: workshop.gestalts, decks: deckSources(workshop.plugins.flatMap((p) => p.decks)) } }
  : { registry: teacher, source: { gestalts: teacher.gestalts } });

/** A view's draft: the preview beside the chat that edits it. */
export function DraftPane({ info, me, agent, onChanged, onDeleted }: { info: api.DraftInfo; me: api.Me; agent: AgentChoice; onChanged: () => void; onDeleted: () => void }) {
  const [{ registry, source }] = useState(() => contextOf(me));
  const init = useCallback(async (repo: Repo) => { await createDraft(repo, info.title, registry.runtime.version, { id: info.id, package: info.package }); }, [info, registry]);
  return (
    <OpenDraft info={info} source={source} init={init}>
      {(repo) => <Workbench repo={repo} registry={registry} info={info} agent={agent} onChanged={onChanged} onDeleted={onDeleted} />}
    </OpenDraft>
  );
}

function Workbench({ repo, registry, info, agent, onChanged, onDeleted }: { repo: Repo; registry: Registry; info: api.DraftInfo; agent: AgentChoice; onChanged: () => void; onDeleted: () => void }) {
  const items = useHostQuery({ gestalt: VIEWS, ids: [info.id] });
  const draft = useMemo(() => (items[0] ? asDraft(items[0]) : undefined), [items]);
  const [errors, setErrors] = useState<ViewError[]>([]);
  const onError = useCallback((e: ViewError) => setErrors((es) => [...es, e].slice(-20)), []);
  const backend = useMemo(() => backendFor(agent, info.id), [agent, info.id]);
  const csp = useMemo(() => closedCsp({ scripts: [`${location.origin}/api/npm/`] }), []);
  const runtime = registry.runtime.version;
  const title = draft?.title;
  useEffect(() => { if (title && title !== info.title) onChanged(); }, [title, info.title, onChanged]);
  if (!draft) return <div className="flex h-full items-center justify-center"><span className="loading loading-spinner" /></div>;
  const suggestion = api.brief.get(info.id);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-base-300 bg-base-100 px-3 py-1">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{draft.title}</span>
        <SyncState />
        <PublishMenu repo={repo} id={info.id} />
        <SubmitMenu source={`workshop:${info.id}`} send={async (offer) => { await repo.connect(api.draftUrl(info.id)); return api.submitDraft(info.id, offer); }} />
        <ExportButton id={info.id} />
        <DeleteButton id={info.id} title={draft.title} onDeleted={onDeleted} />
      </div>
      <div className="grid min-h-0 flex-1 grid-rows-2 md:grid-cols-[minmax(0,1fr)_24rem] md:grid-rows-1">
        <div className="min-h-0 min-w-0">
          <Preview repo={repo} draft={draft} runtime={registry.runtime} css={css} tailwind={tailwind} onError={onError} resolveNpm={api.resolveNpm} csp={csp} />
        </div>
        <div className="min-h-0 border-t border-base-300 md:border-t-0 md:border-l">
          <Chat repo={repo} draft={draft} backend={backend} runtime={runtime} errors={errors} suggestion={suggestion} onTurnDone={() => { setErrors([]); api.brief.clear(info.id); }} />
        </div>
      </div>
    </div>
  );
}

/** Whether the server has what's here; what it refused, if it did. */
export function SyncState() {
  const c = useConnector();
  if (c.state === 'error') return <span role="alert" className="max-w-xs truncate text-xs text-error" title={c.error}>Not saved: {c.error}</span>;
  if (c.state === 'syncing') return <span className="text-xs text-base-content/50">Saving…</span>;
  return <span className="text-xs text-base-content/50">Saved</span>;
}

/** Publishing a draft to a class. `agent`: the draft is the agent's to fix (a view), not only the teacher's. */
export function PublishMenu({ repo, id, agent = true }: { repo: Repo; id: string; agent?: boolean }) {
  const [p, setP] = useState<api.Publication | null>();
  const [busy, setBusy] = useState(false);
  // the checks' problems are the agent's to fix; anything else is said as it is
  const [failed, setFailed] = useState<{ message?: string; problems: string[] }>({ problems: [] });
  const [copied, setCopied] = useState(false);
  useEffect(() => { api.publication(id).then(setP, () => setP(null)); }, [id]);
  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setFailed({ problems: [] });
    try { await f(); } catch (e) {
      setFailed(e instanceof api.ApiError && e.problems.length ? { problems: e.problems } : { message: e instanceof Error ? e.message : String(e), problems: [] });
    } finally { setBusy(false); }
  };
  // what the server publishes is its copy: everything here goes there first
  const publish = () => run(async () => { await repo.connect(api.draftUrl(id)); setP(await api.publish(id, teacher.runtime.version)); });
  const off = () => run(async () => {
    if (!confirm('Switch the link off? Students who open it see that it isn’t available. Publishing again switches it back on.')) return;
    await api.unpublish(id);
    setP(await api.publication(id));
  });
  const copy = async () => {
    if (!p) return;
    await navigator.clipboard.writeText(p.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const live = p && !p.revoked;
  return (
    <details className="dropdown dropdown-end">
      <summary className={`btn btn-sm ${live ? '' : 'btn-primary'}`}><Send className="size-4" /> {live ? 'Published' : 'Publish'}</summary>
      <div className="dropdown-content z-50 mt-2 flex w-80 flex-col gap-2 rounded-box border border-base-300 bg-base-100 p-3 text-sm shadow">
        {live && (
          <>
            <p>Students open it with this link. It works without an account; anyone who has it can open it.</p>
            <div className="flex gap-1">
              <input className="input input-sm min-w-0 flex-1 font-mono text-xs" readOnly value={p.url} onFocus={(e) => e.target.select()} />
              <button type="button" className="btn btn-sm btn-square" onClick={() => void copy()} title="Copy">{copied ? <Check className="size-4" /> : <Copy className="size-4" />}</button>
            </div>
            <p className="text-xs text-base-content/60">Last published {new Date(p.updated).toLocaleString()}.</p>
          </>
        )}
        {p?.revoked && <p className="text-base-content/70">The link is switched off. Publishing switches it on again.</p>}
        {!p && <p>Publishing makes a link for your students. What they do in the lesson stays on their device.</p>}
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void publish()}>
          {busy ? <span className="loading loading-spinner loading-xs" /> : live ? 'Publish changes' : 'Publish'}
        </button>
        {live && <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void off()}><Link2Off className="size-4" /> Switch the link off</button>}
        {p?.warnings.map((w) => <p key={w} className="text-warning">{w}</p>)}
        {failed.message && <p role="alert" className="text-error">It wasn’t published. {failed.message}</p>}
        {failed.problems.length > 0 && (
          <div role="alert" className="flex flex-col gap-1">
            <p className="text-error">{agent ? 'It wasn’t published: it isn’t ready yet. Ask the agent in the chat to fix this (you can paste it):' : 'It wasn’t published: it isn’t ready yet.'}</p>
            <ul className="list-disc pl-5 text-xs text-base-content/70">{failed.problems.map((x) => <li key={x}>{x}</li>)}</ul>
          </div>
        )}
      </div>
    </details>
  );
}

/** The draft as the server keeps it, as a zip: a folder a gestalts node opens. */
export function ExportButton({ id }: { id: string }) {
  return <a className="btn btn-ghost btn-sm btn-square" href={api.exportUrl(id)} download title="Download it, as a folder in a zip"><Download className="size-4" /></a>;
}

export function DeleteButton({ id, title, onDeleted }: { id: string; title: string; onDeleted: () => void }) {
  const remove = async () => {
    if (!confirm(`Delete “${title}”? A link you published keeps working until you switch it off.`)) return;
    await api.deleteDraft(id);
    onDeleted();
  };
  return <button type="button" className="btn btn-ghost btn-sm btn-square" title="Delete" onClick={() => void remove()}><Trash2 className="size-4" /></button>;
}
