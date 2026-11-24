import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Check, Copy, Download, Link2Off, Send, Trash2 } from 'lucide-react';
import { registry as lessons } from 'virtual:gestalts-plugins/lessons';
import { registry as workshop } from 'virtual:gestalts-plugins/workshop';
import { useConnector, useHostQuery, type Repo } from '@gestalts/client';
import { closedCsp, deckSources, type Registry } from '@gestalts/host';
import type { DeckSource } from '@gestalts/client';
import { useLang } from '@gestalts/i18n';
import type { ViewError } from '@gestalts/view';
import { Chat, Preview, VIEWS, asDraft, buildActions, createDraft, flushing, isStarter, viewWork } from '@gestalts/workshop';
import tailwind from '@tailwindcss/browser?raw';
import css from '../app.css?inline';
import { usePickedBackend, type AgentChoice } from './agent';
import { Brief, useDebounced } from './Brief';
import * as api from './api';
import { OpenDraft } from './open';
import { SubmitMenu } from './submit';

/**
 * Where a view's draft is tried out: what it would go out in. An account's is a lesson's (the `lessons` distribution:
 * the core's gestalts and the lesson models, nothing else). A maintainer's is the public site's learning views'
 * (the workshop distribution, with the plugins' decks beside it); what they make can still only be published as a
 * lesson within the lesson models, which the server checks.
 */
const contextOf = (me: api.Me): { registry: Registry; source: { gestalts: string[]; decks?: DeckSource[] } } => (me.maintainer
  ? { registry: workshop, source: { gestalts: workshop.gestalts, decks: deckSources(workshop.plugins.flatMap((p) => p.decks)) } }
  : { registry: lessons, source: { gestalts: lessons.gestalts } });

/** A view's draft: the preview beside the chat that edits it. */
export function DraftPane({ info, me, agent, onChanged, onDeleted }: { info: api.DraftInfo; me: api.Me; agent: AgentChoice; onChanged: () => void; onDeleted: () => void }) {
  const [{ registry, source }] = useState(() => contextOf(me));
  // a brief it was made with (a lesson's plan) becomes its spec
  const init = useCallback(async (repo: Repo) => {
    await createDraft(repo, info.title, registry.runtime.version, { id: info.id, package: info.package, spec: api.brief.get(info.id) });
    api.brief.clear(info.id);
  }, [info, registry]);
  return (
    <OpenDraft info={info} source={source} init={init}>
      {(repo) => <Workbench repo={repo} registry={registry} info={info} agent={agent} onChanged={onChanged} onDeleted={onDeleted} />}
    </OpenDraft>
  );
}

function Workbench({ repo, registry, info, agent, onChanged, onDeleted }: { repo: Repo; registry: Registry; info: api.DraftInfo; agent: AgentChoice; onChanged: () => void; onDeleted: () => void }) {
  const { m } = useLang();
  const items = useHostQuery({ gestalt: VIEWS, ids: [info.id] });
  const draft = useMemo(() => (items[0] ? asDraft(items[0]) : undefined), [items]);
  const [errors, setErrors] = useState<ViewError[]>([]);
  const onError = useCallback((e: ViewError) => setErrors((es) => [...es, e].slice(-20)), []);
  const backend = usePickedBackend(agent, info.id);
  const runtime = registry.runtime.version;
  const base = useMemo(() => viewWork(repo, info.id, runtime), [repo, info.id, runtime]);
  const { edit, flush } = useDebounced((spec) => base.setSpec(spec));
  const work = useMemo(() => flushing(base, flush), [base, flush]);
  const csp = useMemo(() => closedCsp({ scripts: [`${location.origin}/api/npm/`] }), []);
  const title = draft?.title;
  useEffect(() => { if (title && title !== info.title) onChanged(); }, [title, info.title, onChanged]);
  if (!draft) return <div className="flex h-full items-center justify-center"><span className="loading loading-spinner" /></div>;
  return (
    <Shell
      header={(
        <>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{draft.title}</span>
          <SyncState />
          <PublishMenu repo={repo} id={info.id} />
          <SubmitMenu source={`workshop:${info.id}`} send={async (offer) => { await repo.connect(api.draftUrl(info.id)); return api.submitDraft(info.id, offer); }} />
          <ExportButton id={info.id} />
          <DeleteButton id={info.id} title={draft.title} onDeleted={onDeleted} />
        </>
      )}
      preview={<Preview repo={repo} draft={draft} runtime={registry.runtime} css={css} tailwind={tailwind} onError={onError} resolveNpm={api.resolveNpm} csp={csp} />}
      side={(
        <>
          <Brief work={work} spec={draft.spec} edit={edit} flush={flush} placeholder={m.view_brief_placeholder()} />
          <div className="min-h-0 flex-1">
            <Chat work={work} backend={backend} errors={errors} actions={buildActions(m, draft.spec, !isStarter(draft))} onTurnDone={() => setErrors([])} />
          </div>
        </>
      )}
    />
  );
}

/** Every draft's layout, whatever its kind: what it does in its header, what it shows, and beside it its brief and chat. */
export function Shell({ header, preview, side }: { header: ReactNode; preview: ReactNode; side: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-base-300 bg-base-100 px-3 py-1">{header}</div>
      <div className="grid min-h-0 flex-1 grid-rows-2 md:grid-cols-[minmax(0,1fr)_24rem] md:grid-rows-1">
        <div className="min-h-0 min-w-0">{preview}</div>
        <div className="flex min-h-0 flex-col border-t border-base-300 bg-base-100 md:border-t-0 md:border-s">{side}</div>
      </div>
    </div>
  );
}

/** Whether the server has what's here; what it refused, if it did. */
export function SyncState() {
  const { m } = useLang();
  const c = useConnector();
  if (c.state === 'error') return <span role="alert" className="max-w-xs truncate text-xs text-error" title={c.error}>{m.not_saved({ error: c.error ?? '' })}</span>;
  if (c.state === 'syncing') return <span className="text-xs text-base-content/50">{m.saving()}</span>;
  return <span className="text-xs text-base-content/50">{m.saved()}</span>;
}

/** Publishing a draft to a class. `agent`: the draft is the agent's to fix (a view), not only its author's. */
export function PublishMenu({ repo, id, agent = true }: { repo: Repo; id: string; agent?: boolean }) {
  const { m, lang } = useLang();
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
  const publish = () => run(async () => { await repo.connect(api.draftUrl(id)); setP(await api.publish(id, lessons.runtime.version)); });
  const off = () => run(async () => {
    if (!confirm(m.publish_off_confirm())) return;
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
      <summary className={`btn btn-sm ${live ? '' : 'btn-primary'}`}><Send className="size-4" /> {live ? m.published() : m.publish()}</summary>
      <div className="dropdown-content z-50 mt-2 flex w-80 flex-col gap-2 rounded-box border border-base-300 bg-base-100 p-3 text-sm shadow">
        {live && (
          <>
            <p>{m.publish_link()}</p>
            <div className="flex gap-1">
              <input className="input input-sm min-w-0 flex-1 font-mono text-xs" readOnly value={p.url} onFocus={(e) => e.target.select()} />
              <button type="button" className="btn btn-sm btn-square" onClick={() => void copy()} title={m.copy()} aria-label={m.copy()}>{copied ? <Check className="size-4" /> : <Copy className="size-4" />}</button>
            </div>
            <p className="text-xs text-base-content/60">{m.publish_last({ time: new Date(p.updated).toLocaleString(lang) })}</p>
          </>
        )}
        {p?.revoked && <p className="text-base-content/70">{m.publish_revoked()}</p>}
        {!p && <p>{m.publish_about()}</p>}
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void publish()}>
          {busy ? <span className="loading loading-spinner loading-xs" /> : live ? m.publish_changes() : m.publish()}
        </button>
        {live && <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void off()}><Link2Off className="size-4" /> {m.publish_off()}</button>}
        {p?.warnings.map((w) => <p key={w} className="text-warning">{w}</p>)}
        {failed.message && <p role="alert" className="text-error">{m.publish_failed({ error: failed.message })}</p>}
        {failed.problems.length > 0 && (
          <div role="alert" className="flex flex-col gap-1">
            <p className="text-error">{agent ? m.publish_not_ready_agent() : m.publish_not_ready()}</p>
            <ul className="list-disc ps-5 text-xs text-base-content/70">{failed.problems.map((x) => <li key={x}>{x}</li>)}</ul>
          </div>
        )}
      </div>
    </details>
  );
}

/** The draft as the server keeps it, as a zip: a folder a gestalts node opens. */
export function ExportButton({ id }: { id: string }) {
  const { m } = useLang();
  return <a className="btn btn-ghost btn-sm btn-square" href={api.exportUrl(id)} download title={m.download()} aria-label={m.download()}><Download className="size-4" /></a>;
}

export function DeleteButton({ id, title, onDeleted }: { id: string; title: string; onDeleted: () => void }) {
  const { m } = useLang();
  const remove = async () => {
    if (!confirm(m.delete_confirm({ title }))) return;
    await api.deleteDraft(id);
    onDeleted();
  };
  return <button type="button" className="btn btn-ghost btn-sm btn-square" title={m.delete()} aria-label={m.delete()} onClick={() => void remove()}><Trash2 className="size-4" /></button>;
}
