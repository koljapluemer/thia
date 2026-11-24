/**
 * A published lesson: data, not a build. Each version is a folder of static files, immutable once written:
 *
 * ```
 * lessons/<lesson>/<version>/manifest.json   this
 *                            view.js         the compiled view
 *                            index.json      the ymls it ships with, as a published deck: {ymls, blobs}
 *                            ymls.json       [{id, text}], its definitions among them
 *                            blobs/<name>
 * npm/<package>@<version>-<hash>.js           npm bundles, shared by every lesson
 * runtime/<runtime>/                          the player for one frame runtime
 * ```
 *
 * `/l/<lesson>` is the link; `/l/<lesson>/current` answers `{manifest}`, the path of its current version's manifest,
 * which is the one thing that changes (a new version, or 410 once unpublished).
 */
export const LESSON = 'lesson@1';

export type LessonManifest = {
  format: typeof LESSON;
  title: string;
  /** the frame runtime it was compiled against (`FrameRuntime.version`): the player that runs it */
  runtime: string;
  reads: string[];
  writes: string[];
  /** the compiled view, relative to the manifest */
  view: string;
  /** each npm import, by specifier, to the absolute path of its bundle on the lesson domain */
  npm: Record<string, string>;
  /** when this version was published, ISO */
  published: string;
  /** where the view starts (a viz's lesson: the vizint view, on that viz); a link's own params win */
  params?: Record<string, string>;
  /** the language its text is in (BCP 47); English in a lesson published before languages were recorded */
  lang?: string;
  /** where a language is what it teaches: that one */
  target_lang?: string;
};

/** A lesson's id in its link: 128 random bits, base64url. */
export const LESSON_ID = /^[A-Za-z0-9_-]{22}$/;

const KEYS = ['format', 'title', 'runtime', 'reads', 'writes', 'view', 'npm', 'published', 'params', 'lang', 'target_lang'];
const TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const NPM_PATH = /^\/npm\/[A-Za-z0-9._@+-]+\.js$/;

/**
 * A manifest as the player trusts it, or why not. Anything it doesn't know is refused rather than ignored: a manifest
 * asking for the network, a model, a backend or another sandbox isn't a lesson this player runs.
 */
export function parseManifest(v: unknown): LessonManifest {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('a manifest is a map');
  const m = v as Record<string, unknown>;
  const extra = Object.keys(m).filter((k) => !KEYS.includes(k));
  if (extra.length) throw new Error(`a lesson can't have ${extra.join(', ')}`);
  if (m.format !== LESSON) throw new Error(`not a ${LESSON}`);
  const text = (k: string) => { if (typeof m[k] !== 'string' || !(m[k] as string)) throw new Error(`${k} is missing`); return m[k] as string; };
  const list = (k: string) => { if (!Array.isArray(m[k]) || !(m[k] as unknown[]).every((x) => typeof x === 'string')) throw new Error(`${k} must be a list of gestalts`); return m[k] as string[]; };
  const view = text('view');
  if (!/^[A-Za-z0-9._-]+\.js$/.test(view)) throw new Error('view must be a file next to the manifest');
  const npm = m.npm;
  if (typeof npm !== 'object' || npm === null || Array.isArray(npm)) throw new Error('npm must be a map');
  for (const [spec, path] of Object.entries(npm)) if (typeof path !== 'string' || !NPM_PATH.test(path)) throw new Error(`npm: ${spec} must be loaded from /npm/`);
  const writes = list('writes');
  const reads = list('reads');
  for (const g of writes) if (!reads.includes(g)) throw new Error(`it writes ${g} without reading it`);
  const params = m.params;
  if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params) || !Object.values(params).every((x) => typeof x === 'string'))) throw new Error('params must map names to texts');
  const out: LessonManifest = { format: LESSON, title: text('title'), runtime: text('runtime'), reads, writes, view, npm: npm as Record<string, string>, published: text('published') };
  if (params) out.params = params as Record<string, string>;
  for (const k of ['lang', 'target_lang'] as const) {
    if (m[k] === undefined) continue;
    if (typeof m[k] !== 'string' || !TAG.test(m[k] as string)) throw new Error(`${k} must be a language tag`);
    out[k] = m[k] as string;
  }
  return out;
}

/**
 * A lesson of several views (`sequence@1`, published): each view a `lesson@1` folder under `views/<n>/` (its manifest,
 * view and deck), and the steps naming them by index. All on one runtime.
 *
 * ```
 * lessons/<lesson>/<version>/manifest.json         this
 *                            views/<n>/manifest.json  a `lesson@1`, and its files beside it
 * ```
 */
export const SEQUENCE_LESSON = 'lesson@2';

export type SequenceStep = { view: number; skipIfKnown?: string; detour?: { concept: string; view: number } };
export type SequenceManifest = {
  format: typeof SEQUENCE_LESSON;
  title: string;
  runtime: string;
  /** folders relative to the manifest */
  views: string[];
  steps: SequenceStep[];
  published: string;
};

const SEQUENCE_KEYS = ['format', 'title', 'runtime', 'views', 'steps', 'published'];

/** A `lesson@2` manifest as the player trusts it, or why not; as [`parseManifest`], nothing it doesn't know. */
export function parseSequenceManifest(v: unknown): SequenceManifest {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('a manifest is a map');
  const m = v as Record<string, unknown>;
  const extra = Object.keys(m).filter((k) => !SEQUENCE_KEYS.includes(k));
  if (extra.length) throw new Error(`a lesson can't have ${extra.join(', ')}`);
  if (m.format !== SEQUENCE_LESSON) throw new Error(`not a ${SEQUENCE_LESSON}`);
  const text = (k: string) => { if (typeof m[k] !== 'string' || !(m[k] as string)) throw new Error(`${k} is missing`); return m[k] as string; };
  const views = m.views;
  if (!Array.isArray(views) || !views.length || !views.every((f) => typeof f === 'string' && /^views\/[0-9]+$/.test(f))) throw new Error('views must be folders views/<n>');
  const index = (n: unknown) => { if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n >= views.length) throw new Error('a step names a view that isn\'t there'); return n; };
  const concept = (c: unknown) => { if (typeof c !== 'string' || !c) throw new Error('a rule names a concept'); return c; };
  if (!Array.isArray(m.steps) || !m.steps.length) throw new Error('a lesson has steps');
  const steps = (m.steps as unknown[]).map((s): SequenceStep => {
    if (typeof s !== 'object' || s === null) throw new Error('a step is a map');
    const st = s as Record<string, unknown>;
    if (Object.keys(st).some((k) => !['view', 'skipIfKnown', 'detour'].includes(k)) || (st.skipIfKnown !== undefined && st.detour !== undefined)) throw new Error('a step is a view and at most one rule');
    if (st.skipIfKnown !== undefined) return { view: index(st.view), skipIfKnown: concept(st.skipIfKnown) };
    if (st.detour !== undefined) {
      const d = st.detour as Record<string, unknown> | null;
      return { view: index(st.view), detour: { concept: concept(d?.concept), view: index(d?.view) } };
    }
    return { view: index(st.view) };
  });
  return { format: SEQUENCE_LESSON, title: text('title'), runtime: text('runtime'), views: views as string[], steps, published: text('published') };
}
