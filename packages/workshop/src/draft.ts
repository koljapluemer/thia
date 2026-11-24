import type { Repo } from '@gestalts/client';
import type { Item, Json, JsonMap } from '@gestalts/view';
import { parse, stringify } from 'yaml';

/**
 * A draft: one `view@4` yml and its members, the `gestalt@1` definitions and the ymls it ships with. Whatever the view
 * writes while it's tried out stays out of it. A `view@1` reads as a draft without members.
 *
 * The agent sees it as files ([`filesOf`]); what it changed comes back as ymls to write ([`applyFiles`]).
 */
export const VIEW = 'view@4';
/**
 * what reads as a draft: a `view@1` without members, a `view@2` without a brief, a `view@3` in English (written before
 * languages were recorded), written as a `view@4` when saved
 */
export const VIEWS = ['view@1', 'view@2', 'view@3', 'view@4'];
export const DEFINITION = 'gestalt@1';

export type Draft = {
  id: string;
  title: string;
  /** the brief kept with it: what it should be, in its author's words (the agent's SPEC.md) */
  spec: string;
  source: string;
  reads: string[];
  writes: string[];
  /** npm packages it imports, by name, at the version they resolved to */
  npm: Record<string, string>;
  /** the runtime it was last saved against (`FrameRuntime.version`) */
  runtime?: string;
  /** what its own gestalts are named in: `<package>/<name>@<N>` */
  package: string;
  members: string[];
  /** the language its text is written in (BCP 47): the person's who makes it, often not English */
  lang: string;
  /** where a language is what it teaches: that one, whose words are never translated */
  targetLang?: string;
};

/** `tag` as BCP 47 writes it, or undefined if it isn't one. */
const canonicalTag = (tag: string): string | undefined => { try { return Intl.getCanonicalLocales(tag.trim())[0]; } catch { return undefined; } };

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const isMap = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const versions = (v: unknown) => Object.fromEntries(Object.entries(isMap(v) ? v : {}).filter((e): e is [string, string] => typeof e[1] === 'string'));

/** 48 bits of FNV-1a, as hex: a draft's package follows from its id, so a `view@1` gets the same one every time. */
function hash48(s: string): string {
  let a = 0x811c9dc5, b = 0x9dc5811c;
  for (let i = 0; i < s.length; i++) {
    a = Math.imul(a ^ s.charCodeAt(i), 0x01000193) >>> 0;
    b = Math.imul(b ^ s.charCodeAt(s.length - 1 - i), 0x01000193) >>> 0;
  }
  return (a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')).slice(0, 12);
}

export const packageOf = (draftId: string) => `d-${hash48(draftId)}`;

/** `gestalt-<package>.<name>.<N>`, as the core names a definition yml. */
export const definitionId = (pkg: string, name: string, version: number) => `gestalt-${pkg}.${name}.${version}`;

export function asDraft(i: Item): Draft {
  const v = i.value;
  return {
    id: i.id,
    title: String(v.title ?? ''),
    spec: typeof v.spec === 'string' ? v.spec : '',
    source: String(v.source ?? ''),
    reads: strings(v.reads),
    writes: strings(v.writes),
    npm: versions(v.npm),
    runtime: typeof v.runtime === 'string' ? v.runtime : undefined,
    package: typeof v.package === 'string' ? v.package : packageOf(i.id),
    members: strings(v.members),
    lang: typeof v.lang === 'string' && v.lang ? v.lang : 'en',
    targetLang: typeof v.target_lang === 'string' && v.target_lang ? v.target_lang : undefined,
  };
}

const STARTER = `export default function View() {
  return <div className="flex h-full items-center justify-center text-base-content/60">Tell me what this should be.</div>;
}
`;

/** Whether the agent has made anything of it yet: it's still what a new draft starts with. */
export const isStarter = (d: Pick<Draft, 'source'>) => d.source === STARTER;

/**
 * A new draft named after `title`, its text in `lang` (its maker's); its id can be a file name. A server that hands out
 * drafts gives the id and package (`given`); otherwise they're made here.
 */
export async function createDraft(repo: Pick<Repo, 'put'>, title: string, runtime?: string, given?: { id: string; package: string; spec?: string }, lang = 'en'): Promise<string> {
  const slug = title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'view';
  const id = given?.id ?? `${slug}-${hash48(`${title}:${Date.now()}:${Math.random()}`).slice(0, 8)}`;
  await repo.put(viewYml({ id, title, spec: given?.spec ?? '', source: STARTER, reads: [], writes: [], npm: {}, runtime, package: given?.package ?? packageOf(id), members: [], lang }));
  return id;
}

function viewYml(d: Draft): JsonMap {
  const out: JsonMap = { id: d.id, gestalt: VIEW, title: d.title, source: d.source, reads: d.reads, writes: d.writes, package: d.package, lang: d.lang };
  if (d.targetLang) out.target_lang = d.targetLang;
  if (d.spec) out.spec = d.spec;
  if (Object.keys(d.npm).length) out.npm = d.npm;
  if (d.runtime) out.runtime = d.runtime;
  if (d.members.length) out.members = d.members;
  return out;
}

/** Adds `ids` to the draft's members (ymls written already), keeping the rest as it is. */
export const addMembers = (repo: Pick<Repo, 'put'>, d: Draft, ids: string[]) =>
  repo.put(viewYml({ ...d, members: [...d.members, ...ids.filter((id) => !d.members.includes(id))] }));

/** Keeps `spec` as the draft's brief, the rest as it is. */
export const saveSpec = (repo: Pick<Repo, 'put'>, d: Draft, spec: string) => repo.put(viewYml({ ...d, spec }));

/** The draft's members as they are now, a page at a time. One that's gone or invalid is left out. */
export async function loadMembers(repo: Pick<Repo, 'query'>, draft: Draft): Promise<Item[]> {
  const out: Item[] = [];
  for (let at = 0; at < draft.members.length; at += 500) {
    const ids = draft.members.slice(at, at + 500);
    const page = await repo.query({ ids, limit: 500 });
    out.push(...page.items);
  }
  return out;
}

/**
 * Its maker's rewordings and translations of its text (`wording-<lang>`, `wording-<lang>-override`): the agent doesn't
 * see them and can't change them; they stay members whatever a turn does. The agent's own text is `wording`.
 */
export const isMakers = (id: string) => id.startsWith('wording-');

const DEF_FILE = /^gestalts\/([a-z0-9-]+)@([1-9][0-9]*)\.yml$/;
const DATA_FILE = /^data\/([^/\\]+)\.yml$/;

/** The draft as the agent sees it. */
export function filesOf(d: Draft, members: Item[]): Record<string, string> {
  const files: Record<string, string> = {
    'view.tsx': d.source,
    'view.json': `${JSON.stringify({ title: d.title, package: d.package, lang: d.lang, ...(d.targetLang ? { target_lang: d.targetLang } : {}), reads: d.reads, writes: d.writes, npm: d.npm }, null, 2)}\n`,
  };
  for (const m of members) {
    if (isMakers(m.id)) continue;
    if (m.gestalt === DEFINITION) {
      const { id: _id, gestalt: _g, name, version, ...rest } = m.value;
      const short = String(name).split('/').pop();
      files[`gestalts/${short}@${String(version)}.yml`] = stringify(rest);
    } else {
      files[`data/${m.id}.yml`] = stringify(m.value);
    }
  }
  return files;
}

export type DraftChange = {
  draft: Draft;
  /** ymls to write: definitions first, so what follows is judged by them */
  put: JsonMap[];
  /** members no longer in the files */
  remove: string[];
  /** ids that weren't members before */
  added: string[];
  /** files that couldn't be read; the rest is applied */
  problems: string[];
};

/** Keys in a stable order, so equal values compare equal whatever order they were written in. */
function canonical(v: Json | unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isMap(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/**
 * What a turn's changed files (`null`: deleted) make of the draft. A `view.json` that doesn't parse changes nothing;
 * a member file that doesn't parse stays as it was and is reported.
 */
export function applyFiles(d: Draft, members: Item[], changed: Record<string, string | null>): DraftChange {
  const files: Record<string, string | null> = { ...filesOf(d, members), ...changed };
  const problems: string[] = [];
  const draft: Draft = { ...d };
  if (typeof files['view.tsx'] === 'string') draft.source = files['view.tsx'];
  if (typeof changed['view.json'] === 'string') {
    try {
      const m = JSON.parse(changed['view.json']) as Record<string, unknown>;
      if (typeof m.title === 'string' && m.title.trim()) draft.title = m.title;
      draft.reads = strings(m.reads);
      draft.writes = strings(m.writes);
      draft.npm = versions(m.npm);
      if (typeof m.lang === 'string' && canonicalTag(m.lang)) draft.lang = canonicalTag(m.lang)!;
      else if (m.lang !== undefined) problems.push(`view.json: lang ${JSON.stringify(m.lang)} isn't a language tag (BCP 47: de, en, vi)`);
      draft.targetLang = typeof m.target_lang === 'string' && canonicalTag(m.target_lang) ? canonicalTag(m.target_lang) : undefined;
    } catch (e) {
      problems.push(`view.json: ${(e as Error).message}`);
    }
  }
  const before = new Map(members.map((m) => [m.id, m]));
  const definitions: JsonMap[] = [];
  const data: JsonMap[] = [];
  for (const [path, text] of Object.entries(files)) {
    if (text === null) continue;
    const def = DEF_FILE.exec(path);
    const datum = DATA_FILE.exec(path);
    if (!def && !datum) {
      if (path !== 'view.tsx' && path !== 'view.json') problems.push(`${path}: not part of a draft (gestalts/<name>@<N>.yml or data/<id>.yml)`);
      continue;
    }
    let value: unknown;
    try {
      value = parse(text);
    } catch (e) {
      problems.push(`${path}: ${(e as Error).message}`);
      const kept = def ? before.get(definitionId(d.package, def[1], Number(def[2]))) : before.get(datum![1]);
      if (kept) (def ? definitions : data).push(kept.value);
      continue;
    }
    if (!isMap(value)) {
      problems.push(`${path}: must be a map`);
      continue;
    }
    if (def) {
      const { id: _id, gestalt: _g, name: _n, version: _v, ...rest } = value;
      const version = Number(def[2]);
      definitions.push({ id: definitionId(d.package, def[1], version), gestalt: DEFINITION, name: `${d.package}/${def[1]}`, version, ...(rest as JsonMap) });
    } else if (isMakers(datum![1])) {
      problems.push(`${path}: its maker's own rewording or translation, which only they change: leave it out`);
    } else {
      data.push({ ...(value as JsonMap), id: datum![1] });
    }
  }
  const all = [...definitions, ...data];
  draft.members = [...all.map((v) => String(v.id)), ...d.members.filter(isMakers)];
  const put = all.filter((v) => { const old = before.get(String(v.id)); return !old || canonical(old.value) !== canonical(v); });
  const remove = members.map((m) => m.id).filter((id) => !draft.members.includes(id));
  const added = draft.members.filter((id) => !before.has(id));
  return { draft, put, remove, added, problems };
}

/**
 * Writes a change: definitions, then the rest, then deletions, then the view. A yml the repo refuses is reported; a new
 * one is left out of the members, so the draft never lists what isn't there.
 */
export async function saveDraft(repo: Pick<Repo, 'put' | 'delete'>, change: DraftChange, runtime?: string): Promise<{ draft: Draft; problems: string[] }> {
  const problems = [...change.problems];
  const refused = new Set<string>();
  for (const v of change.put) {
    try {
      await repo.put(v);
    } catch (e) {
      refused.add(String(v.id));
      problems.push(`${String(v.id)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  for (const id of change.remove) await repo.delete(id);
  const added = new Set(change.added);
  const draft = { ...change.draft, runtime: runtime ?? change.draft.runtime, members: change.draft.members.filter((id) => !(refused.has(id) && added.has(id))) };
  await repo.put(viewYml(draft));
  return { draft, problems };
}
