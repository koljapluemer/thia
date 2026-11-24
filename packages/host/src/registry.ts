import type { DeckSource } from '@gestalts/client';
import type { Wording } from '@gestalts/view/wording';

/** What a view's frame may be allowed beyond the strict sandbox; only the distribution grants it (`grants`). */
export type Permission = 'same-origin' | 'microphone';

/** A plugin's `plugin.yml`. */
export type PluginManifest = {
  id: string;
  version: string;
  title: string;
  description?: string;
  reads?: string[];
  writes?: string[];
  tags?: string[];
  requires?: 'backend'[];
  /** what its frame asks to be allowed; only the distribution grants it (`grants` in `distribution.yml`) */
  permissions?: Permission[];
  /** hosts it may reach through the node, exactly */
  network?: string[];
  /** asks for completions from the user's LLM providers */
  llm?: boolean;
  /** the npm packages its view imports, at exact versions */
  npm?: Record<string, string>;
  /** the language its view's text is written in (BCP 47); English if not said */
  lang?: string;
  /** where a language is what it teaches, whatever its decks: that one */
  target_lang?: string;
};

/**
 * One of a plugin's decks, as the build serves it: `source` is `<plugin>/<deck>`, `path` relative to the app.
 * `practises`: the names of the concepts a view opened on it practises as a whole (a deck@3's or @4's), most weight
 * first. `lang`: the language its text is in, `targetLang` the one it teaches (a `deck@4`'s); none for an older deck.
 */
export type DeckEntry = { id: string; title: string; source: string; path: string; practises: string[]; lang?: string; targetLang?: string;
  /** the ids of the concepts it practises as a whole: decks of one view practising the same are siblings, one per language */
  concepts?: string[] };

/** A plugin the app is built with. */
export type PluginEntry = {
  manifest: PluginManifest;
  decks: DeckEntry[];
  /** its view's text: the source and each translation and rewording of it (`wording/`) */
  wording?: Wording[];
  /** its view, compiled */
  js: string;
  /** npm packages its view imports */
  npm: string[];
  /** where the build put each of `npm`, bundled, relative to the app (a distribution with `pinned_npm`); else esm.sh */
  npmUrls?: Record<string, string>;
  /** what the distribution granted of what it asked for */
  granted: Permission[];
  /** it has a `backend.py`: required when the manifest says `requires: [backend]`, else optional */
  backend: boolean;
};

/** `id`: what its views' kept state is under, for good. */
export type Distribution = { id: string };

/** What every view's frame loads: React, the kit and the rest, as one script, and their styles. */
/** What every frame loads. `version` names it: a hash of `js`, so a lesson or draft can say what it was made against. */
export type FrameRuntime = { js: string; css: string; version: string };

/**
 * A curriculum or guide the distribution lists (`outlines:`), as the catalog shows it; the build ships its tree, with
 * the views under each entry, as `outlines/<name>.json`. `region` (ISO 3166-2) only when an authority issued it;
 * `replacedBy` names the outline of the edition after it. `leaves` are entries without children.
 */
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

/**
 * One entry of an outline's tree: the views (`<plugin>/<deck>`) that fit it and none of its descendants, best first,
 * and how many fit it or a descendant (`count`).
 */
export type OutlineTreeEntry = {
  id: string;
  label: string;
  notation?: string;
  kind?: string;
  level?: string;
  grades?: number[];
  isced?: number;
  concepts?: string[];
  views: { source: string; score: number }[];
  count: number;
  entries?: OutlineTreeEntry[];
};

/** `outlines/<name>.json`: an outline's tree. */
export type OutlineTree = OutlineSummary & { id: string; subject?: string; schoolType?: string; entries: OutlineTreeEntry[] };

/** `gestalts`: the definitions of the distribution's model packages, as YAML (the core's are compiled in). */
export type Registry = { distribution: Distribution; plugins: PluginEntry[]; gestalts: string[]; outlines?: OutlineSummary[]; runtime: FrameRuntime };

export const findPlugin = (registry: Registry, id: string) => registry.plugins.find((p) => p.manifest.id === id);

/** The plugin's npm bundles as URLs, where the build made them. */
export function npmUrlsOf(p: PluginEntry): Record<string, string> | undefined {
  return p.npmUrls && Object.fromEntries(Object.entries(p.npmUrls).map(([spec, path]) => [spec, new URL(path, document.baseURI).href]));
}

export function deckSources(decks: DeckEntry[]): DeckSource[] {
  return decks.map((d) => ({ source: d.source, url: new URL(d.path, document.baseURI).href }));
}
