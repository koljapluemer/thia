/**
 * A distribution's outlines (`outlines:` in `distribution.yml`, each a folder in the repo's `outlines/`): which views
 * are found under each entry, worked out once per build by the core (`outline_index`, through the wasm), from the
 * outlines' ymls and only the `deck@3` and concept ymls of the distribution's decks. The site gets a summary per
 * outline in its registry and the whole tree as `outlines/<name>.json`, loaded only by the outline's page; entries
 * no view practises, and leaves nobody said anything about, are `outlines/<name>.gaps.json`, for whoever writes the
 * next view.
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The core, compiled to wasm by `mise run setup`. */
const WASM = resolve(import.meta.dirname, '../../client/wasm');

export type OutlineDir = { name: string; root: string };

/** A summary for the catalog, in the registry. */
export type OutlineSummary = {
  name: string;
  title: string;
  lang: string;
  issuer?: string;
  region?: string;
  edition?: string;
  replaces?: string;
  replacedBy?: string;
  leaves: number;
  leavesWithViews: number;
};

type View = { source: string; score: number };
export type IndexedEntry = { id: string; label: string; notation?: string; kind?: string; level?: string; grades?: number[]; isced?: number; concepts?: string[]; views: View[]; entries?: IndexedEntry[] };
type Gap = { id: string; label: string; notation?: string; concepts?: string[] };
type IndexedOutline = OutlineSummary & { id: string; subject?: string; schoolType?: string; entries: IndexedEntry[]; unpractised: Gap[]; unmapped: Gap[] };
type Index = { outlines: IndexedOutline[]; skipped: string[] };

/** What the build ships of one outline. */
export type BuiltOutline = { summary: OutlineSummary; json: string; gaps: string };

const ymlsOf = (dir: string, keep: (file: string, text: string) => boolean = () => true) => {
  const notes = join(dir, 'notes');
  return readdirSync(notes).filter((f) => f.endsWith('.yml')).sort().flatMap((f) => {
    const text = readFileSync(join(notes, f), 'utf8');
    return keep(f, text) ? [{ id: f.slice(0, -'.yml'.length), text }] : [];
  });
};

/** An outline's folder, from a distribution file's `outlines:`: published, holding one `outline@1`. */
export function loadOutline(base: string, path: string, where: string): OutlineDir {
  const root = realpathSync(resolve(base, path));
  const name = basename(root);
  if (!existsSync(join(root, 'index.json'))) throw new Error(`${where}: outline ${name} has no index.json; run \`mise run publish-data outlines/${name}\``);
  if (!ymlsOf(root).some((y) => /^gestalt:\s*outline@1\s*$/m.test(y.text))) throw new Error(`${where}: outlines/${name} holds no outline@1`);
  return { name, root };
}

let core: Promise<{ outlineIndex: (input: string) => string }> | undefined;

function loadCore() {
  core ??= (async () => {
    const glue = join(WASM, 'gestalts.js');
    if (!existsSync(glue)) throw new Error(`the core isn't compiled to wasm (${glue}); run \`mise run setup\``);
    const m = (await import(pathToFileURL(glue).href)) as { initSync: (o: { module: Uint8Array }) => unknown; outlineIndex?: (input: string) => string };
    m.initSync({ module: readFileSync(join(WASM, 'gestalts_bg.wasm')) });
    if (!m.outlineIndex) throw new Error('the compiled core has no outlineIndex; run `mise run setup`');
    return { outlineIndex: m.outlineIndex };
  })();
  return core;
}

/** Every outline with the views under its entries, from the distribution's decks (`<plugin>/<deck>` and its folder). */
export async function buildOutlines(outlines: OutlineDir[], decks: { source: string; dir: string }[]): Promise<BuiltOutline[]> {
  if (!outlines.length) return [];
  const input = {
    outlines: outlines.map((o) => ({ source: o.name, ymls: ymlsOf(o.root) })),
    // what a deck is about is its deck yml and the concepts it names; nothing else of it is read
    decks: decks.map((d) => ({ source: d.source, ymls: ymlsOf(d.dir, (f, t) => f.startsWith('concept-') || /^gestalt:\s*deck@\d+\s*$/m.test(t)) })),
  };
  const index = JSON.parse((await loadCore()).outlineIndex(JSON.stringify(input))) as Index;
  for (const s of index.skipped) console.warn(`outlines: ${s} is no deck@3, so no outline finds it`);
  return index.outlines.map(({ unpractised, unmapped, ...o }) => {
    console.log(`outlines: ${o.name}: ${o.leavesWithViews} of ${o.leaves} leaves with views; ${unpractised.length} entries no view practises, ${unmapped.length} leaves without concepts`);
    const summary: OutlineSummary = {
      name: o.name, title: o.title, lang: o.lang, leaves: o.leaves, leavesWithViews: o.leavesWithViews,
      ...(o.issuer ? { issuer: o.issuer } : {}), ...(o.region ? { region: o.region } : {}), ...(o.edition ? { edition: o.edition } : {}),
      ...(o.replaces ? { replaces: o.replaces } : {}), ...(o.replacedBy ? { replacedBy: o.replacedBy } : {}),
    };
    return { summary, json: JSON.stringify(o), gaps: JSON.stringify({ unpractised, unmapped }, null, 1) };
  });
}
