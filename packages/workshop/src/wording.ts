/**
 * Rewording a draft's text, as its maker does in the workshop (never in the use app): the agent writes the source
 * (`data/wording.yml`); the maker's own wording of a key is an `override` in its language (`wording-<lang>-override`,
 * the source's language included), and a translation is `wording-<lang>` (`machine`, then `reviewed`). Every entry is
 * signed with the hash of the source text it was written against, so a changed source shows it as stale; the agent
 * can't overwrite the maker's words, and a key the agent dropped is listed, not lost.
 */
import type { Repo } from '@gestalts/client';
import type { Item, JsonMap } from '@gestalts/view';
import { MessageError, argsOf, parseMessage } from '@gestalts/view/icu';
import { WORDING, asWording, textHash, type Layer, type Wording } from '@gestalts/view/wording';
import { addMembers, type Draft } from './draft';

export type WordingYml = { id: string; wording: Wording };

/** The wordings among a draft's members. */
export const wordingsOf = (items: Item[]): WordingYml[] => items.flatMap((i) => {
  if (i.gestalt !== WORDING) return [];
  const wording = asWording(i.value);
  return wording ? [{ id: i.id, wording }] : [];
});

/** Where a language's layer is kept: one translation per language, which is `machine` until marked `reviewed`. */
export const wordingId = (lang: string, layer: Layer) => (layer === 'override' ? `wording-${lang.toLowerCase()}-override` : `wording-${lang.toLowerCase()}`);

export type Row = {
  key: string;
  description?: string;
  /** the source's text */
  source: string;
  /** what it shows in the language: the first fresh entry of override, reviewed, machine, else the source */
  text: string;
  from: Layer;
  /** entries in the language written against another source text, by layer */
  stale: { layer: Layer; text: string }[];
};

/** A key no longer in the source, with what was written for it: shown, so the maker decides what becomes of it. */
export type Gone = { id: string; layer: Layer; lang: string; key: string; text: string };

const RANK: Layer[] = ['override', 'reviewed', 'machine'];

/** The draft's text in `lang`, key by key, and what was written for keys the source no longer has. */
export function rowsFor(wordings: WordingYml[], lang: string): { source?: Wording; rows: Row[]; gone: Gone[]; langs: string[] } {
  const source = wordings.find((w) => w.wording.layer === 'source')?.wording;
  const langs = [...new Set([source?.lang, ...wordings.map((w) => w.wording.lang)].filter((l): l is string => !!l))];
  const gone = wordings.filter((w) => w.wording.layer !== 'source').flatMap((w) => Object.entries(w.wording.messages)
    .filter(([key]) => !source?.messages[key])
    .map(([key, e]) => ({ id: w.id, layer: w.wording.layer, lang: w.wording.lang, key, text: e.text })));
  if (!source) return { rows: [], gone, langs };
  const layers = (layer: Layer) => wordings.filter((w) => w.wording.layer === layer && w.wording.lang.toLowerCase() === lang.toLowerCase()).map((w) => w.wording);
  const rows = Object.entries(source.messages).map(([key, e]): Row => {
    const hash = textHash(e.text);
    const stale: Row['stale'] = [];
    let shown: { text: string; from: Layer } | undefined;
    for (const layer of RANK) {
      for (const w of layers(layer)) {
        const entry = w.messages[key];
        if (!entry) continue;
        if (entry.source !== hash) stale.push({ layer, text: entry.text });
        else shown ??= { text: entry.text, from: layer };
      }
    }
    return { key, description: e.description, source: e.text, text: shown?.text ?? e.text, from: shown?.from ?? 'source', stale };
  });
  return { source, rows, gone, langs };
}

/**
 * What's wrong with `text` as the wording of a key whose source is `source`: it must parse (`parse`: ICU's own
 * complaint), and take the placeholders the source takes, no fewer (`missing`) and no others (`extra`). The page says
 * it in its language.
 */
export type MessageProblem = { parse?: string; missing: string[]; extra: string[] };
export function messageProblem(text: string, source: string): MessageProblem | undefined {
  let have: Map<string, string>;
  try { have = argsOf(parseMessage(text)); } catch (e) { return { parse: e instanceof MessageError ? e.message : String(e), missing: [], extra: [] }; }
  let want: Map<string, string>;
  try { want = argsOf(parseMessage(source)); } catch { return undefined; }
  const missing = [...want.keys()].filter((k) => !have.has(k));
  const extra = [...have.keys()].filter((k) => !want.has(k));
  return missing.length || extra.length ? { missing, extra } : undefined;
}

type Writer = Pick<Repo, 'put'>;

/** The yml of `w`, as written. */
const ymlOf = (id: string, w: Wording): JsonMap => ({
  id, gestalt: WORDING, lang: w.lang, layer: w.layer, ...(w.catalog ? { catalog: w.catalog } : {}),
  messages: Object.fromEntries(Object.entries(w.messages).map(([k, e]) => [k, { text: e.text, ...(e.description ? { description: e.description } : {}), ...(e.source ? { source: e.source } : {}) }])),
});

/**
 * Sets `key`'s text in `lang`'s `layer` (null: removes it), signed against the source's text now; the yml is made,
 * and made a member, when it isn't there yet.
 */
export async function setEntry(repo: Writer, draft: Draft, wordings: WordingYml[], lang: string, layer: Exclude<Layer, 'source'>, key: string, text: string | null): Promise<void> {
  const source = wordings.find((w) => w.wording.layer === 'source')?.wording;
  const id = wordingId(lang, layer);
  const had = wordings.find((w) => w.id === id)?.wording;
  // a translation keeps its layer (machine or reviewed); a new one written by a person is reviewed
  const w: Wording = had ?? { lang, layer: layer === 'override' ? 'override' : 'reviewed', messages: {} };
  const messages = { ...w.messages };
  if (text === null) delete messages[key];
  else messages[key] = { text, ...(source?.messages[key] ? { source: textHash(source.messages[key].text) } : {}) };
  await repo.put(ymlOf(id, { ...w, messages }));
  if (!draft.members.includes(id)) await addMembers(repo, draft, [id]);
}

/** Keeps a stale entry: signs it against the source's text now, as it is. */
export async function keepEntry(repo: Writer, wordings: WordingYml[], id: string, key: string): Promise<void> {
  const w = wordings.find((x) => x.id === id);
  const source = wordings.find((x) => x.wording.layer === 'source')?.wording.messages[key];
  const entry = w?.wording.messages[key];
  if (!w || !source || !entry) return;
  await repo.put(ymlOf(w.id, { ...w.wording, messages: { ...w.wording.messages, [key]: { ...entry, source: textHash(source.text) } } }));
}

/** Removes `key` from the yml `id` (a stale or a gone entry). */
export async function dropEntry(repo: Writer, wordings: WordingYml[], id: string, key: string): Promise<void> {
  const w = wordings.find((x) => x.id === id);
  if (!w) return;
  const { [key]: _gone, ...messages } = w.wording.messages;
  await repo.put(ymlOf(w.id, { ...w.wording, messages }));
}

/** Marks a machine translation as read by a person. */
export async function markReviewed(repo: Writer, wordings: WordingYml[], lang: string): Promise<void> {
  const w = wordings.find((x) => x.id === wordingId(lang, 'machine'));
  if (w && w.wording.layer === 'machine') await repo.put(ymlOf(w.id, { ...w.wording, layer: 'reviewed' }));
}

/** Writes a whole layer (a translation made from the source): replaces what was there. */
export async function putWording(repo: Writer, draft: Draft, w: Wording): Promise<void> {
  const id = wordingId(w.lang, w.layer === 'override' ? 'override' : 'machine');
  await repo.put(ymlOf(id, w));
  if (!draft.members.includes(id)) await addMembers(repo, draft, [id]);
}
