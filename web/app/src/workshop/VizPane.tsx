import { useCallback, useEffect, useMemo } from 'react';
import { registry } from 'virtual:gestalts-plugins/workshop';
import { useHostQuery, type Repo } from '@gestalts/client';
import { SingleView } from '@gestalts/host';
import css from '../app.css?inline';
import * as api from './api';
import { ExportButton, SyncState } from './DraftPane';
import { OpenDraft } from './open';
import { SubmitMenu } from './submit';
import { Editor } from './viz/Editor';
import { VIZ, asViz, createViz } from './viz/viz';

/** The vizint view shows the viz as the public site will; vizzes go there, never to a class. */
const SOURCE = { gestalts: registry.gestalts };
const NO_NAVIGATION = () => {};

/**
 * A visualization's draft (`viz@1`): its texts and files beside the vizint view showing it, built from its spec by
 * Claude Code on this computer, through the Claude bridge, whose check renders it. The server's agent can't build one
 * until the server can render.
 */
export function VizPane({ info, onChanged, onDeleted }: { info: api.DraftInfo; onChanged: () => void; onDeleted: () => void }) {
  const init = useCallback(async (repo: Repo) => { await createViz(repo, info.id, info.title); }, [info]);
  return (
    <OpenDraft info={info} source={SOURCE} init={init}>
      {(repo) => <Workbench repo={repo} info={info} onChanged={onChanged} onDeleted={onDeleted} />}
    </OpenDraft>
  );
}

function Workbench({ repo, info, onChanged, onDeleted }: { repo: Repo; info: api.DraftInfo; onChanged: () => void; onDeleted: () => void }) {
  const current = useHostQuery({ gestalt: VIZ, ids: [info.id], limit: 1 })[0];
  const viz = useMemo(() => (current ? asViz(current) : null), [current]);
  const params = useMemo(() => ({ viz: info.id }), [info.id]);
  const title = viz?.title;
  useEffect(() => { if (title && title !== info.title) onChanged(); }, [title, info.title, onChanged]);
  const remove = async () => { await api.deleteDraft(info.id); onDeleted(); };
  if (!viz) return <div className="flex h-full items-center justify-center"><span className="loading loading-spinner" /></div>;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-base-300 bg-base-100 px-3 py-1">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{viz.title}</span>
        <SyncState />
        <SubmitMenu source={`workshop:${info.id}`} ready={Boolean(viz.built)} send={async (offer) => { await repo.connect(api.draftUrl(info.id)); return api.submitDraft(info.id, offer); }} />
        <ExportButton id={info.id} />
      </div>
      <div className="grid min-h-0 flex-1 grid-rows-2 md:grid-cols-[24rem_minmax(0,1fr)] md:grid-rows-1">
        <div className="min-h-0 border-b border-base-300 md:border-r md:border-b-0">
          <Editor key={viz.id} repo={repo} viz={viz} onDelete={() => void remove()} />
        </div>
        <div className="min-h-0 min-w-0"><SingleView registry={registry} css={css} view="vizint" params={params} onParams={NO_NAVIGATION} /></div>
      </div>
    </div>
  );
}
