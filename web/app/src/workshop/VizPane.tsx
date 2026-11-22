import { useCallback, useEffect, useMemo } from 'react';
import { registry } from 'virtual:gestalts-plugins/workshop';
import { useHostQuery, type Repo } from '@gestalts/client';
import { SingleView } from '@gestalts/host';
import { Chat, VIZ, asViz, buildActions, createViz, flushing, vizWork } from '@gestalts/workshop';
import css from '../app.css?inline';
import { backendFor, type AgentChoice } from './agent';
import * as api from './api';
import { Brief, useDebounced } from './Brief';
import { DeleteButton, ExportButton, Shell, SyncState } from './DraftPane';
import { OpenDraft } from './open';
import { SubmitMenu } from './submit';
import { Editor } from './viz/Editor';

/** The vizint view shows the viz as the public site will. */
const SOURCE = { gestalts: registry.gestalts };
const NO_NAVIGATION = () => {};
/** a viz's preview doesn't report errors to the chat: its check renders it after every turn that changed it */
const NO_ERRORS: never[] = [];

/**
 * A visualization's draft (`viz@1`), laid out as every draft is: the vizint view showing it, beside it its brief and
 * the chat with whichever agent Settings picks. After a turn that changed it, the page builds and renders it, and keeps
 * the page only when that passes (`vizWork`).
 */
export function VizPane({ info, agent, onChanged, onDeleted }: { info: api.DraftInfo; agent: AgentChoice; onChanged: () => void; onDeleted: () => void }) {
  const init = useCallback(async (repo: Repo) => {
    await createViz(repo, info.id, info.title, api.brief.get(info.id));
    api.brief.clear(info.id);
  }, [info]);
  return (
    <OpenDraft info={info} source={SOURCE} init={init}>
      {(repo) => <Workbench repo={repo} info={info} agent={agent} onChanged={onChanged} onDeleted={onDeleted} />}
    </OpenDraft>
  );
}

function Workbench({ repo, info, agent, onChanged, onDeleted }: { repo: Repo; info: api.DraftInfo; agent: AgentChoice; onChanged: () => void; onDeleted: () => void }) {
  const current = useHostQuery({ gestalt: VIZ, ids: [info.id], limit: 1 })[0];
  const viz = useMemo(() => (current ? asViz(current) : null), [current]);
  const params = useMemo(() => ({ viz: info.id }), [info.id]);
  const backend = useMemo(() => backendFor(agent, info.id), [agent, info.id]);
  const base = useMemo(() => vizWork(repo, info.id), [repo, info.id]);
  const { edit, flush } = useDebounced((spec) => base.setSpec(spec));
  const work = useMemo(() => flushing(base, flush), [base, flush]);
  const title = viz?.title;
  useEffect(() => { if (title && title !== info.title) onChanged(); }, [title, info.title, onChanged]);
  if (!viz) return <div className="flex h-full items-center justify-center"><span className="loading loading-spinner" /></div>;
  return (
    <Shell
      header={(
        <>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{viz.title}</span>
          <SyncState />
          <SubmitMenu source={`workshop:${info.id}`} ready={Boolean(viz.built)} send={async (offer) => { await repo.connect(api.draftUrl(info.id)); return api.submitDraft(info.id, offer); }} />
          <ExportButton id={info.id} />
          <DeleteButton id={info.id} title={viz.title} onDeleted={onDeleted} />
        </>
      )}
      preview={<SingleView registry={registry} css={css} view="vizint" params={params} onParams={NO_NAVIGATION} />}
      side={(
        <>
          <Brief work={work} spec={viz.spec} edit={edit} flush={flush} placeholder="e.g. Show how a Bézier curve is drawn by de Casteljau's construction; the control points are draggable." />
          <Editor key={viz.id} repo={repo} viz={viz} />
          <div className="min-h-0 flex-1">
            <Chat work={work} backend={backend} errors={NO_ERRORS} actions={buildActions(viz.spec, Boolean(viz.source))} onTurnDone={() => {}} />
          </div>
        </>
      )}
    />
  );
}
