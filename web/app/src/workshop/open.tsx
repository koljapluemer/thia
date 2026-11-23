import { useEffect, useState, type ReactNode } from 'react';
import { RepoProvider, useOpenRepo, type DeckSource, type Repo } from '@gestalts/client';
import * as api from './api';

/**
 * One draft: its own folder in this browser, synced with the server's copy, which the server checks. Opening it
 * makes its view or viz (`init`) if the server has none yet. `source` says which gestalts and decks it opens with: the
 * context it would go out in.
 */
export function OpenDraft({ info, source, init, children }: {
  info: api.DraftInfo; source: { gestalts: string[]; decks?: DeckSource[] }; init: (repo: Repo) => Promise<void>; children: (repo: Repo) => ReactNode;
}) {
  const [opened] = useState(() => ({ ...source, dir: `draft-${info.id}` }));
  const { repo, error } = useOpenRepo(opened);
  const [ready, setReady] = useState<Repo>();
  const [failed, setFailed] = useState<string>();
  const [first] = useState(() => init);
  useEffect(() => {
    if (!repo) return;
    let live = true;
    (async () => {
      await repo.connect(api.draftUrl(info.id));
      if (!(await repo.get(info.id))) await first(repo);
      if (live) setReady(repo);
      // the folder this browser kept it in before (`teacher-draft-<id>`): only a copy of the server's, so it goes
      void navigator.storage?.getDirectory?.().then((d) => d.removeEntry(`teacher-draft-${info.id}`, { recursive: true })).catch(() => {});
    })().catch((e: unknown) => { if (live) setFailed(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [repo, info.id, first]);
  const problem = error ?? failed;
  if (problem) return <div role="alert" className="alert alert-error m-4">This draft couldn’t open: {problem}</div>;
  if (!ready) return <div className="flex h-full items-center justify-center"><span className="loading loading-spinner" /></div>;
  return <RepoProvider repo={ready}>{children(ready)}</RepoProvider>;
}
