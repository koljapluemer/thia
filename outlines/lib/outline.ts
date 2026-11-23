// What every outline's builder shares: the tree as it's parsed, its ids, the concepts mapped onto it by hand, and
// writing it all as an outline's notes/ (then `mise run publish-data outlines/<name>`).
//
// Ids: `outline-<sha16(name)>`, `outline-entry-<sha16(name + "/" + key)>`, where `key` is the issuer's notation or,
// without one, the path of ordinals from the top (`2/4/1`); a concept is `concept-<sha16(its name)>`, the rule every
// deck's builder follows, and where a deck in plugins/ ships that concept, its yml is copied as it is.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse, stringify } from 'yaml';

export const sha = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);
export const conceptId = (name: string) => `concept-${sha(name)}`;

export type Node = {
  label: string;
  notation?: string;
  kind?: string;
  level?: string;
  grades?: number[];
  isced?: number;
  /** where the hand-written concepts find it (`tools/concepts.yml`): its notation, or labels joined by ` › ` */
  key: string;
  children: Node[];
};

export type Meta = {
  name: string;
  title: string;
  lang: string;
  issuer?: string;
  region?: string;
  subject?: string;
  school_type?: string;
  edition?: string;
  valid_from?: string;
};

/** concept name to weight (1 about it, 0.5 needed or practised, 0.2 it comes up), by an entry's key */
export type Mapping = Record<string, Record<string, number>>;

const repo = resolve(import.meta.dirname, '../..');

/** The concept ymls decks in plugins/ ship, by id, so an outline writes the same text for the same concept. */
function deckConcepts(): Map<string, string> {
  const out = new Map<string, string>();
  const plugins = join(repo, 'plugins');
  for (const p of readdirSync(plugins)) {
    const decks = join(plugins, p, 'decks');
    if (!existsSync(decks)) continue;
    for (const d of readdirSync(decks)) {
      const notes = join(decks, d, 'notes');
      if (!existsSync(notes)) continue;
      for (const f of readdirSync(notes).filter((f) => f.startsWith('concept-'))) out.set(f.slice(0, -4), readFileSync(join(notes, f), 'utf8'));
    }
  }
  return out;
}

export function readMapping(file: string): Mapping {
  return existsSync(file) ? ((parse(readFileSync(file, 'utf8')) ?? {}) as Mapping) : {};
}

const WEIGHTS = new Set([1, 0.5, 0.2]);

/** Writes the outline's notes/ afresh: the outline, its entries, its source and the concepts it names. */
export function write(dir: string, meta: Meta, top: Node[], source: Record<string, unknown>, mapping: Mapping) {
  const notes = join(dir, 'notes');
  rmSync(notes, { recursive: true, force: true });
  mkdirSync(notes, { recursive: true });
  const put = (v: Record<string, unknown>) => writeFileSync(join(notes, `${v.id}.yml`), stringify(v, { lineWidth: 0 }));
  const shipped = deckConcepts();
  const used = new Set<string>();
  const keys = new Set<string>();
  let entries = 0;

  const entry = (n: Node, path: string): string => {
    if (keys.has(n.key)) throw new Error(`two entries have the key ${n.key}`);
    keys.add(n.key);
    const id = `outline-entry-${sha(`${meta.name}/${n.notation ?? path}`)}`;
    const children = n.children.map((c, i) => entry(c, `${path}/${i + 1}`));
    const about = mapping[n.key];
    for (const [c, w] of Object.entries(about ?? {})) {
      if (!WEIGHTS.has(w)) throw new Error(`${n.key}: ${c} weighs ${w}; weights are 1, 0.5 or 0.2`);
      used.add(c);
    }
    put({
      id,
      gestalt: 'outline-entry@1',
      label: n.label,
      ...(n.notation ? { notation: n.notation } : {}),
      ...(n.kind ? { kind: n.kind } : {}),
      ...(n.level ? { level: n.level } : {}),
      ...(n.grades?.length ? { grades: n.grades } : {}),
      ...(n.isced !== undefined ? { isced: n.isced } : {}),
      ...(about && Object.keys(about).length ? { concepts: Object.fromEntries(Object.entries(about).sort().map(([c, w]) => [conceptId(c), w])) } : {}),
      ...(children.length ? { entries: children } : {}),
    });
    entries++;
    return id;
  };

  const ids = top.map((n, i) => entry(n, String(i + 1)));
  const unknown = Object.keys(mapping).filter((k) => !keys.has(k));
  if (unknown.length) throw new Error(`tools/concepts.yml names entries that aren't there: ${unknown.join('; ')}`);
  put(source);
  put({ id: `outline-${sha(meta.name)}`, gestalt: 'outline@1', ...meta, source: source.id, entries: ids });
  for (const c of [...used].sort()) {
    const id = conceptId(c);
    const text = shipped.get(id);
    if (text) writeFileSync(join(notes, `${id}.yml`), text);
    else put({ id, gestalt: 'concept@2', name: c });
  }
  const mapped = Object.values(mapping).filter((m) => Object.keys(m).length).length;
  console.log(`${meta.name}: ${entries} entries, ${mapped} with concepts, ${used.size} concepts (${[...used].filter((c) => shipped.has(conceptId(c))).length} a deck ships)`);
}
