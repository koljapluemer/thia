import { useEffect, useMemo, useState } from 'react';
import { registry } from 'virtual:gestalts-plugins';
import { closedCsp } from '@gestalts/host';
import { LESSON_ID, parseManifest, type LessonManifest } from '@gestalts/workshop/lesson';
import { Notice, RunPage, Spinner, type Run } from './Run';

/**
 * A teacher's lesson, from its link `/l/<lesson>` on the lesson domain: its current version's manifest, its view, and
 * its ymls as the deck it opens on. Unlisted: only who has the link finds it. The view runs under the closed CSP.
 */
type Loaded = { id: string; manifest: LessonManifest; base: string; js: string };

class Gone extends Error {}

export function lessonId(path: string): string | null {
  const m = /^\/l\/([^/]+)\/?$/.exec(path);
  return m && LESSON_ID.test(m[1]) ? m[1] : null;
}

async function load(id: string): Promise<Loaded> {
  const r = await fetch(`/l/${id}/current`, { cache: 'no-cache' });
  if (r.status === 404 || r.status === 410) throw new Gone();
  if (!r.ok) throw new Error(`the lesson couldn't be loaded (${r.status})`);
  const { manifest: path } = (await r.json()) as { manifest?: string };
  if (typeof path !== 'string' || !new RegExp(`^/lessons/${id}/[A-Za-z0-9_-]+/manifest\\.json$`).test(path)) throw new Error('the lesson points somewhere it may not');
  const manifest = parseManifest(await (await fetch(path)).json());
  const base = path.slice(0, -'manifest.json'.length);
  const view = await fetch(base + manifest.view);
  if (!view.ok) throw new Error(`the lesson's view couldn't be loaded (${view.status})`);
  return { id, manifest, base, js: await view.text() };
}

export function Lesson({ id }: { id: string }) {
  const [lesson, setLesson] = useState<Loaded>();
  const [error, setError] = useState<{ gone?: boolean; message?: string }>();
  useEffect(() => {
    load(id).then((l) => {
      if (l.manifest.runtime !== registry.runtime.version) {
        // the lesson moved on to another build since this page loaded: the link serves that one now
        const tried = `player:reloaded:${id}:${l.manifest.runtime}`;
        if (!sessionStorage.getItem(tried)) {
          sessionStorage.setItem(tried, '1');
          location.reload();
          return;
        }
        setError({ message: 'This lesson needs another version of this page, which isn’t here.' });
        return;
      }
      setLesson(l);
    }, (e: unknown) => setError(e instanceof Gone ? { gone: true } : { message: e instanceof Error ? e.message : String(e) }));
  }, [id]);

  if (error?.gone) return <Notice title="This lesson isn’t available">The link was switched off or has expired. Ask your teacher for a new one.</Notice>;
  if (error) return <Notice title="The lesson couldn’t start">{error.message}</Notice>;
  if (!lesson) return <Spinner />;
  return <Loaded lesson={lesson} />;
}

function Loaded({ lesson }: { lesson: Loaded }) {
  const { id, manifest, base, js } = lesson;
  const run = useMemo<Run>(() => ({
    title: manifest.title,
    // as the player named them, so what students did before stays theirs
    dir: `lesson-${id}`,
    keys: { state: `player:state:${id}`, generation: `player:generation:${id}` },
    deck: { source: `lesson/${id}`, url: new URL(base, location.origin).href.replace(/\/$/, '') },
    view: {
      id: `lesson-${id}`,
      title: manifest.title,
      js,
      npm: Object.keys(manifest.npm),
      npmUrls: Object.fromEntries(Object.entries(manifest.npm).map(([spec, path]) => [spec, new URL(path, location.origin).href])),
      scope: { reads: manifest.reads, writes: manifest.writes },
    },
    csp: closedCsp({ scripts: [`${location.origin}/npm/`] }),
  }), [id, manifest, base, js]);
  return <RunPage run={run} />;
}
