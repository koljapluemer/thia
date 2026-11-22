import type { Repo } from '@gestalts/client';
import type { Item, JsonMap } from '@gestalts/view';

/** One viz is one yml (gestalts/viz/viz/v1.yml). */
export const VIZ = 'viz@1';

export type BlobRef = { file: string; label: string };
export type Viz = {
  id: string; title: string; intro: string; spec: string; outro: string; source: string; packages: string[];
  files: BlobRef[]; built?: string; still?: string; generator?: string;
};

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const refs = (v: unknown): BlobRef[] => (Array.isArray(v)
  ? v.filter((x): x is BlobRef => !!x && typeof x === 'object' && typeof x.file === 'string' && typeof x.label === 'string')
  : []);

export function asViz(i: Item): Viz {
  const v = i.value;
  return {
    id: i.id, title: str(v.title), intro: str(v.intro), spec: str(v.spec), outro: str(v.outro), source: str(v.source),
    packages: strings(v.packages), files: refs(v.files),
    built: str(v.built) || undefined, still: str(v.still) || undefined, generator: str(v.generator) || undefined,
  };
}

/** The yml for `v`, leaving out what's empty (an empty prop is still a prop). */
export function vizYml(v: Viz): JsonMap {
  const out: JsonMap = { id: v.id, gestalt: VIZ, title: v.title || 'Untitled' };
  for (const k of ['intro', 'spec', 'outro', 'source', 'built', 'still', 'generator'] as const) if (v[k]) out[k] = v[k];
  if (v.packages.length) out.packages = v.packages;
  if (v.files.length) out.files = v.files;
  return out;
}

export const saveViz = (repo: Pick<Repo, 'put'>, v: Viz) => repo.put(vizYml(v));

/** A draft's viz, empty but for its title and brief: its id is the draft's, which the server handed out. */
export const createViz = (repo: Pick<Repo, 'put'>, id: string, title: string, spec = '') =>
  saveViz(repo, { id, title, intro: '', spec, outro: '', source: '', packages: [], files: [] });

/** Stores `bytes` as a blob named by its content, as published decks name them. */
export async function storeBlob(repo: Pick<Repo, 'writeBlob'>, bytes: Uint8Array, ext: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  const name = `${Array.from(digest.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('')}.${ext}`;
  await repo.writeBlob(name, bytes);
  return name;
}

/** A viz's packages (`name@version`) as the package.json the agent edits. */
export const packagesJson = (packages: string[]) => `${JSON.stringify({
  private: true, type: 'module', dependencies: Object.fromEntries(packages.map((p) => [p.slice(0, p.lastIndexOf('@')), p.slice(p.lastIndexOf('@') + 1)])),
}, null, 2)}\n`;
