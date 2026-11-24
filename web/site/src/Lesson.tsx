import { useEffect, useMemo, useState } from 'react';
import { registry } from 'virtual:gestalts-plugins';
import { closedCsp } from '@gestalts/host';
import { asWording, type Wording } from '@gestalts/view/wording';
import { useLang } from '@gestalts/i18n';
import { LESSON_ID, SEQUENCE_LESSON, parseManifest, parseSequenceManifest, type LessonManifest } from '@gestalts/workshop/lesson';
import { Notice, RunPage, Spinner, type Run } from './Run';
import { SequencePage, type LoadedSequence } from './Sequence';

/**
 * A published lesson, from its link `/l/<lesson>` on the lesson domain: its current version's manifest, its view, and
 * its ymls as the deck it opens on. Unlisted: only who has the link finds it. The view runs under the closed CSP. A
 * lesson of several views (`lesson@2`) is each of its views so, played as a sequence.
 */
type Loaded = { id: string; manifest: LessonManifest; base: string; js: string; wording?: Wording[] };
type Any = { kind: 'one'; lesson: Loaded } | { kind: 'sequence'; lesson: LoadedSequence };

class Gone extends Error {}

export function lessonId(path: string): string | null {
  const m = /^\/l\/([^/]+)\/?$/.exec(path);
  return m && LESSON_ID.test(m[1]) ? m[1] : null;
}

/** A `lesson@1` folder: its manifest, its view and the view's text. */
async function loadView(base: string, raw: unknown): Promise<{ manifest: LessonManifest; base: string; js: string; wording?: Wording[] }> {
  const manifest = parseManifest(raw);
  const [view, wording] = await Promise.all([fetch(base + manifest.view), manifest.wording ? fetch(base + manifest.wording) : undefined]);
  if (!view.ok) throw new Error(`the lesson's view couldn't be loaded (${view.status})`);
  // its text, each layer; a lesson without it shows its keys, so one that won't load is an error
  if (wording && !wording.ok) throw new Error(`the lesson's text couldn't be loaded (${wording.status})`);
  const layers = wording ? ((await wording.json()) as Record<string, unknown>[]).flatMap((w) => asWording(w) ?? []) : undefined;
  return { manifest, base, js: await view.text(), ...(layers ? { wording: layers } : {}) };
}

async function load(id: string): Promise<Any> {
  const r = await fetch(`/l/${id}/current`, { cache: 'no-cache' });
  if (r.status === 404 || r.status === 410) throw new Gone();
  if (!r.ok) throw new Error(`the lesson couldn't be loaded (${r.status})`);
  const { manifest: path } = (await r.json()) as { manifest?: string };
  if (typeof path !== 'string' || !new RegExp(`^/lessons/${id}/[A-Za-z0-9_-]+/manifest\\.json$`).test(path)) throw new Error('the lesson points somewhere it may not');
  const raw = (await (await fetch(path)).json()) as { format?: unknown };
  const base = path.slice(0, -'manifest.json'.length);
  if (raw?.format === SEQUENCE_LESSON) {
    const manifest = parseSequenceManifest(raw);
    const views = await Promise.all(manifest.views.map(async (f) => {
      const at = `${base}${f}/`;
      return loadView(at, await (await fetch(`${at}manifest.json`)).json());
    }));
    if (views.some((v) => v.manifest.runtime !== manifest.runtime)) throw new Error('the lesson’s steps were made for different versions of this page');
    return { kind: 'sequence', lesson: { id, manifest, views } };
  }
  return { kind: 'one', lesson: { id, ...(await loadView(base, raw)) } };
}

export function Lesson({ id }: { id: string }) {
  const { m } = useLang();
  const [lesson, setLesson] = useState<Any>();
  const [error, setError] = useState<{ gone?: boolean; other?: boolean; message?: string }>();
  useEffect(() => {
    load(id).then((l) => {
      if (l.lesson.manifest.runtime !== registry.runtime.version) {
        // the lesson moved on to another build since this page loaded: the link serves that one now
        const tried = `player:reloaded:${id}:${l.lesson.manifest.runtime}`;
        if (!sessionStorage.getItem(tried)) {
          sessionStorage.setItem(tried, '1');
          location.reload();
          return;
        }
        setError({ other: true });
        return;
      }
      setLesson(l);
    }, (e: unknown) => setError(e instanceof Gone ? { gone: true } : { message: e instanceof Error ? e.message : String(e) }));
  }, [id]);

  if (error?.gone) return <Notice title={m.lesson_gone()}>{m.lesson_gone_text()}</Notice>;
  if (error) return <Notice title={m.lesson_failed()}>{error.other ? m.lesson_other_version() : error.message}</Notice>;
  if (!lesson) return <Spinner />;
  return lesson.kind === 'sequence' ? <SequencePage lesson={lesson.lesson} /> : <Loaded lesson={lesson.lesson} />;
}

function Loaded({ lesson }: { lesson: Loaded }) {
  const { id, manifest, base, js, wording } = lesson;
  const run = useMemo<Run>(() => ({
    title: manifest.title,
    // as the player named them, so what students did before stays theirs
    dir: `lesson-${id}`,
    keys: { state: `player:state:${id}`, generation: `player:generation:${id}` },
    deck: { source: `lesson/${id}`, url: new URL(base, location.origin).href.replace(/\/$/, '') },
    view: {
      id: `lesson-${id}`,
      title: manifest.title,
      lang: manifest.lang,
      js,
      npm: Object.keys(manifest.npm),
      npmUrls: Object.fromEntries(Object.entries(manifest.npm).map(([spec, path]) => [spec, new URL(path, location.origin).href])),
      scope: { reads: manifest.reads, writes: manifest.writes },
    },
    params: manifest.params,
    csp: closedCsp({ scripts: [`${location.origin}/npm/`] }),
    wording,
  }), [id, manifest, base, js, wording]);
  return <RunPage run={run} />;
}
