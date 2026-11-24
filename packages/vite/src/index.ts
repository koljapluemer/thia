/**
 * What an app builds with, as the virtual module `virtual:gestalts-plugins`. `distribution.yml` next to the app names
 * the distribution and lists its plugins and model packages (the gestalts beyond the core's), as folders. An app with
 * several (one per area) has `distributions/<name>.yml` instead, each as `virtual:gestalts-plugins/<name>`. Each
 * plugin's `view.tsx` is compiled to the module its frame runs, and everything frames load (React, the kit, learning)
 * is built into one script, shared by all of an app's distributions. The host never imports a plugin.
 *
 * npm packages a view imports are pinned in its `plugin.yml` (`npm: {name: exact-version}`). A distribution with
 * `pinned_npm: true` (the public site) refuses a view that imports one unpinned, and bundles each one into the build
 * (`npm/<file>.js`, with `@gestalts/npm-bundle`), so its views load nothing from elsewhere; others load npm from esm.sh.
 *
 * `outlines` lists curricula and guides (folders in the repo's `outlines/`); the build works out the views under each
 * entry (`outlines.ts`) and ships them as `outlines/<name>.json`, with a summary in the registry.
 *
 * Packages may be linked from a sibling checkout, so this also dedupes React (and lucide), lets the dev server read
 * those checkouts, and replaces `@gestalts-sources;` in the app's CSS with an `@source` per package and plugin
 * (Tailwind doesn't reliably scan through pnpm's symlinks). List it before `tailwindcss()`.
 */
import { asWording, type Wording } from '@gestalts/view/wording';
import { wordingProblems } from '@gestalts/view/wording-check';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { bundle, isVersion, packageName } from '@gestalts/npm-bundle';
import { NEEDS as KIT_NEEDS } from '@gestalts/kit/needs';
import { NEEDS as LEARNING_NEEDS } from '@gestalts/learning/needs';
import { compile, type Compiled } from '@gestalts/view/compile';
import { needsProblems } from '@gestalts/view/needs';
import { build, searchForWorkspaceRoot, type Plugin, type PluginOption, type Rollup } from 'vite';
import { parse } from 'yaml';
// by its package path: Node loads this file as it is when Vite reads the app's config, and needs no extension so
import { grantsFor } from '@gestalts/vite/grants';
import { type BuiltOutline, buildOutlines, loadOutline } from '@gestalts/vite/outlines';

const VIRTUAL = 'virtual:gestalts-plugins';
const RESOLVED = '\0' + VIRTUAL;
const DISTRIBUTIONS = 'distributions';
/** the frame runtime, once for all of an app's registries */
const RUNTIME = 'virtual:gestalts-runtime';
const SOURCES = /^@gestalts-sources;$/m;

type Manifest = { id: string; title: string; version: string; reads?: string[]; writes?: string[]; requires?: string[]; permissions?: string[]; npm?: Record<string, string>; lang?: string; target_lang?: string };
type DistributionFile = { id?: unknown; plugins?: string[]; models?: string[]; outlines?: string[]; grants?: unknown; pinned_npm?: boolean };
const DISTRIBUTION_KEYS = ['id', 'plugins', 'models', 'outlines', 'grants', 'pinned_npm'];
/** where npm bundles are kept between builds */
const NPM_CACHE = resolve(import.meta.dirname, '../../../node_modules/.cache/gestalts-npm');
/** The repo's `gestalts/`: the core's (`<name>/v<N>.yml`, compiled in) and the model packages (`<package>/<name>/`). */
const GESTALTS = resolve(import.meta.dirname, '../../../gestalts');
type PackageJson = { dependencies?: Record<string, string> };

function dependencies(root: string): string[] {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageJson;
  return Object.keys(pkg.dependencies ?? {});
}

function packageRoot(root: string, name: string): string {
  const link = join(root, 'node_modules', name);
  if (!existsSync(link)) throw new Error(`${name} is not installed in ${root}; run \`mise run just setup\``);
  return realpathSync(link);
}

/** The real folders of the app's `@gestalts*` packages, and theirs in turn. */
function gestaltsPackages(appRoot: string): string[] {
  const found = new Set<string>();
  const visit = (root: string) => {
    for (const name of dependencies(root).filter((d) => d.startsWith('@gestalts'))) {
      const dir = packageRoot(root, name);
      if (!found.has(dir)) { found.add(dir); visit(dir); }
    }
  };
  visit(appRoot);
  return [...found];
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();
const definitionsIn = (dir: string) => readdirSync(dir).filter((f) => /^v\d+\.yml$/.test(f)).sort().map((f) => join(dir, f));
const subdirs = (dir: string) => readdirSync(dir).map((n) => join(dir, n)).filter(isDir).sort();
/** A folder of gestalt folders, not one of the core's (which holds `v<N>.yml`). */
const isPackage = (dir: string) => isDir(dir) && !definitionsIn(dir).length && subdirs(dir).some((g) => definitionsIn(g).length > 0);
const gestaltId = (text: string) => { const d = parse(text) as { name: string; version: number }; return `${d.name}@${d.version}`; };

/** A model package's definitions, as YAML, and the gestalts they define. */
function loadModel(base: string, path: string, where: string) {
  const root = realpathSync(resolve(base, path));
  if (!isPackage(root)) throw new Error(`${where}: model ${path} is not a package (gestalts/<package>/<name>/v<N>.yml)`);
  const texts = subdirs(root).flatMap(definitionsIn).map((f) => readFileSync(f, 'utf8'));
  return { root, texts, ids: texts.map(gestaltId) };
}

/** The core's gestalts, compiled in: every `gestalts/<name>/v<N>.yml`. */
function coreGestalts(): Set<string> {
  if (!isDir(GESTALTS)) return new Set();
  return new Set(subdirs(GESTALTS).filter((d) => !isPackage(d)).flatMap(definitionsIn).map((f) => gestaltId(readFileSync(f, 'utf8'))));
}

/** The repo's package defining `id`, to say what to add. */
function packageOf(id: string): string | undefined {
  if (!isDir(GESTALTS)) return undefined;
  return subdirs(GESTALTS).filter(isPackage).find((p) => subdirs(p).flatMap(definitionsIn).some((f) => gestaltId(readFileSync(f, 'utf8')) === id));
}

/**
 * Every yml of a published deck as one file, `[{id, text}]`, in its `index.json`'s order: the app reads a deck in one
 * download instead of one per yml. Made from the deck as it is, so it's never out of date or committed.
 */
function deckBundle(dir: string): string {
  const { ymls } = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as { ymls: string[] };
  return JSON.stringify(ymls.flatMap((id) => {
    const f = join(dir, 'notes', `${id}.yml`);
    return existsSync(f) ? [{ id, text: readFileSync(f, 'utf8') }] : [];
  }));
}

/** The decks in a plugin's `decks/`; each is titled by the `deck` yml in it. */
function readDecks(pluginId: string, root: string) {
  const dir = join(root, 'decks');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((id) => statSync(join(dir, id)).isDirectory()).map((id) => {
    const deck = join(dir, id);
    if (!existsSync(join(deck, 'index.json'))) throw new Error(`${pluginId}: its deck ${id} has no index.json; run \`mise run publish-data ${relative(process.cwd(), deck)}\``);
    const ymls = readdirSync(join(deck, 'notes')).map((f) => parse(readFileSync(join(deck, 'notes', f), 'utf8')) as { id?: string; gestalt?: string; title?: string; name?: string; concepts?: Record<string, number>; lang?: string; target_lang?: string });
    const meta = ymls.find((y) => /^deck@[1-4]$/.test(y.gestalt ?? ''));
    if (!meta) throw new Error(`${pluginId}: its deck ${id} has no deck yml`);
    const gestalts = [...new Set(ymls.flatMap((y) => (typeof y.gestalt === 'string' ? [y.gestalt] : [])))];
    // what a view opened on it practises (deck@3, deck@4), by the names of the concepts it ships, most weight first
    const names = new Map(ymls.flatMap((y) => (y.id && typeof y.name === 'string' && y.gestalt?.startsWith('concept@') ? [[y.id, y.name] as const] : [])));
    const practising = meta.gestalt === 'deck@3' || meta.gestalt === 'deck@4';
    const practises = Object.entries(practising ? meta.concepts ?? {} : {}).sort((a, b) => b[1] - a[1]).flatMap(([c]) => names.get(c) ?? []);
    // its language, a deck@4's
    const lang: { lang?: string; targetLang?: string } = meta.gestalt === 'deck@4' ? { lang: meta.lang, ...(meta.target_lang ? { targetLang: meta.target_lang } : {}) } : {};
    return { id, title: meta.title ?? meta.name ?? id, dir: deck, gestalts, practises, ...lang };
  });
}

/**
 * What's wrong with how a plugin's `plugin.yml` says what its view reads and writes: every part of the kit and of
 * learning it uses needs its gestalts declared there too (each package's `needs.ts`), by hand, so its author and
 * whoever reviews it see everything it touches.
 */
export function pluginNeedsProblems(manifest: Pick<Manifest, 'reads' | 'writes'>, compiled: Extract<Compiled, { ok: true }>): string[] {
  return needsProblems({
    imports: compiled.imports, reads: manifest.reads ?? [], writes: manifest.writes ?? [], manifest: 'plugin.yml',
    needs: { '@gestalts/kit': KIT_NEEDS, '@gestalts/learning': LEARNING_NEEDS },
  });
}

/** A plugin folder's manifest and its view, compiled. */
export function readPlugin(root: string): { manifest: Manifest; compiled: Compiled } {
  const manifest = parse(readFileSync(join(root, 'plugin.yml'), 'utf8')) as Manifest;
  const viewFile = join(root, 'view.tsx');
  return { manifest, compiled: compile(readFileSync(viewFile, 'utf8'), viewFile) };
}

/**
 * A plugin's wordings (`wording/<name>.yml`, `wording@1` without `gestalt`): its view's text, the source in its
 * `lang` and each translation and rewording of it. Refused when they don't hold together (`wordingProblems`).
 */
export function readWording(id: string, root: string, lang = 'en'): Wording[] {
  const dir = join(root, 'wording');
  if (!existsSync(dir)) return [];
  const found = readdirSync(dir).filter((f) => f.endsWith('.yml')).sort().map((f) => {
    const raw = parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>;
    const wording = asWording(raw);
    if (!wording) throw new Error(`${id}/wording/${f}: a wording has lang, layer and messages ({key: {text, …}})`);
    return { name: `${id}/wording/${f}`, wording };
  });
  const { problems } = wordingProblems(found);
  const source = found.find((w) => w.wording.layer === 'source');
  if (source && source.wording.lang !== lang) problems.push(`${source.name}: its lang ${source.wording.lang} isn't plugin.yml's (${lang})`);
  if (problems.length) throw new Error(problems.join('\n'));
  return found.map((w) => w.wording);
}

function loadPlugin(base: string, path: string) {
  const root = realpathSync(resolve(base, path));
  const { manifest, compiled } = readPlugin(root);
  if (!compiled.ok) throw new Error(`${manifest.id}/view.tsx: ${compiled.errors.map((e) => `${e.line ?? '?'}: ${e.message}`).join('; ')}`);
  const needs = pluginNeedsProblems(manifest, compiled);
  if (needs.length) throw new Error(`${manifest.id}: ${needs.join('; ')}`);
  if (existsSync(join(root, 'gestalts'))) throw new Error(`${manifest.id}: a plugin doesn't define gestalts; they go in a model package, gestalts/<package>/<name>/v<N>.yml`);
  return { id: manifest.id, root, manifest, decks: readDecks(manifest.id, root), wording: readWording(manifest.id, root, manifest.lang), js: compiled.js, npm: compiled.npm, backend: existsSync(join(root, 'backend.py')) };
}

/**
 * The app's distributions, by the name its virtual module has: `''` for `distribution.yml` (`virtual:gestalts-plugins`),
 * `<name>` for each `distributions/<name>.yml` (`virtual:gestalts-plugins/<name>`).
 */
export function distributionFiles(appRoot: string): Map<string, string> {
  const single = join(appRoot, 'distribution.yml');
  const dir = join(appRoot, DISTRIBUTIONS);
  if (existsSync(single) && isDir(dir)) throw new Error(`${appRoot} has both distribution.yml and ${DISTRIBUTIONS}/: one or the other`);
  if (existsSync(single)) return new Map([['', single]]);
  if (!isDir(dir)) throw new Error(`${appRoot} has no distribution.yml (nor ${DISTRIBUTIONS}/<name>.yml)`);
  const names = readdirSync(dir).filter((f) => f.endsWith('.yml')).sort();
  for (const f of names) if (!/^[a-z0-9-]+\.yml$/.test(f)) throw new Error(`${DISTRIBUTIONS}/${f}: name it with lowercase letters, digits and -`);
  return new Map(names.map((f) => [f.slice(0, -'.yml'.length), join(dir, f)]));
}

/** One distribution, from its file; paths in it are from that file. */
export function loadDistribution(file: string) {
  const base = dirname(file);
  const where = basename(base) === DISTRIBUTIONS ? `${DISTRIBUTIONS}/${basename(file)}` : basename(file);
  const parsed = parse(readFileSync(file, 'utf8')) as DistributionFile;
  const unknown = Object.keys(parsed).filter((k) => !DISTRIBUTION_KEYS.includes(k));
  if (unknown.length) throw new Error(`${where}: unknown key ${unknown.join(', ')} (known: ${DISTRIBUTION_KEYS.join(', ')})`);
  if (typeof parsed.id !== 'string' || !/^[a-z0-9-]+$/.test(parsed.id)) throw new Error(`${where} needs an \`id\` (lowercase letters, digits and -)`);
  const plugins = (parsed.plugins ?? []).map((p) => loadPlugin(base, p));
  const seen = new Set<string>();
  for (const p of plugins) {
    if (seen.has(p.id)) throw new Error(`${where}: plugin ${p.id} is listed twice`);
    seen.add(p.id);
  }
  const models = (parsed.models ?? []).map((m) => loadModel(base, m, where));
  // every gestalt a view reads or a deck holds is the core's or a named model's
  const defined = new Set([...coreGestalts(), ...models.flatMap((m) => m.ids)]);
  for (const p of plugins) {
    const used = [...(p.manifest.reads ?? []).map((g) => [g, 'reads'] as const), ...p.decks.flatMap((d) => d.gestalts.map((g) => [g, `its deck ${d.id} holds`] as const))];
    for (const [g, how] of used) {
      if (defined.has(g)) continue;
      const pkg = packageOf(g);
      throw new Error(`${where}: ${p.id} ${how} ${g}, which ${pkg ? `package ${relative(base, pkg)} defines: add it to \`models\`` : 'nothing defines'}`);
    }
  }
  const pinned = parsed.pinned_npm ?? false;
  if (pinned) for (const p of plugins) for (const spec of p.npm) {
    const name = packageName(spec);
    const version = name && p.manifest.npm?.[name];
    if (!version || !isVersion(version)) throw new Error(`${where}: ${p.id} imports ${spec}: pin ${name ?? spec} to an exact version in its plugin.yml (npm: {${name ?? spec}: <version>})`);
  }
  const granted = grantsFor(parsed.grants, plugins.map((p) => ({ id: p.id, permissions: p.manifest.permissions, npm: p.npm })));
  const outlines = (parsed.outlines ?? []).map((o) => loadOutline(base, o, where));
  if (new Set(outlines.map((o) => o.name)).size !== outlines.length) throw new Error(`${where}: an outline is listed twice`);
  return {
    file,
    distribution: { id: parsed.id },
    pinned,
    plugins: plugins.map((p) => ({ ...p, granted: granted.get(p.id) ?? [] })),
    models,
    outlines,
  };
}

type Loaded = ReturnType<typeof loadDistribution>;

/**
 * Every distribution of the app, by name. Distributions may share a plugin (the same folder), whose decks are then
 * served once; two different plugins with one id would serve each other's decks, so they're refused.
 */
export function loadApp(appRoot: string): Map<string, Loaded> {
  const loaded = new Map([...distributionFiles(appRoot)].map(([name, file]) => [name, loadDistribution(file)] as const));
  const ids = new Set<string>();
  const roots = new Map<string, string>();
  for (const [name, d] of loaded) {
    if (ids.has(d.distribution.id)) throw new Error(`${DISTRIBUTIONS}/${name}.yml: id ${d.distribution.id} is another distribution's too`);
    ids.add(d.distribution.id);
    for (const p of d.plugins) {
      const other = roots.get(p.id);
      if (other !== undefined && other !== p.root) throw new Error(`plugin id ${p.id} is two plugins: ${other} and ${p.root}`);
      roots.set(p.id, p.root);
    }
  }
  return loaded;
}

/** Each plugin of the app once, whichever distributions it is in. */
function appPlugins(appRoot: string): Loaded['plugins'] {
  const byId = new Map<string, Loaded['plugins'][number]>();
  for (const d of loadApp(appRoot).values()) for (const p of d.plugins) byId.set(p.id, p);
  return [...byId.values()];
}

/** A bundle's file in the build: by specifier, version and content. */
const npmFile = (spec: string, version: string, hash: string) => `npm/${spec.replace(/[^A-Za-z0-9._@-]/g, '+')}@${version}-${hash.slice(0, 12)}.js`;

/**
 * Each npm import of a pinned distribution's plugins bundled, and what a subpath needs besides (its package's root),
 * as `{plugin id: {specifier: file in the build}}`; the bundles' cache files by their file in the build.
 */
async function bundleNpm(plugins: Loaded['plugins'], files: Map<string, string>): Promise<Record<string, Record<string, string>>> {
  const out: Record<string, Record<string, string>> = {};
  for (const p of plugins) {
    const urls: Record<string, string> = {};
    const todo = [...p.npm];
    for (let spec = todo.shift(); spec !== undefined; spec = todo.shift()) {
      if (urls[spec]) continue;
      const version = p.manifest.npm?.[packageName(spec) ?? ''] ?? '';
      const b = await bundle(spec, version, { cacheDir: NPM_CACHE });
      const file = npmFile(spec, version, b.hash);
      files.set(file, b.file);
      urls[spec] = file;
      todo.push(...b.needs);
    }
    if (Object.keys(urls).length) out[p.id] = urls;
  }
  return out;
}

/** Everything a frame loads, as one script and its styles. */
async function buildRuntime(appRoot: string): Promise<{ js: string; css: string; version: string }> {
  const host = gestaltsPackages(appRoot).find((d) => /[\\/]host$/.test(d));
  if (!host) throw new Error('the app has no @gestalts/host');
  const result = await build({
    configFile: false,
    logLevel: 'warn',
    root: host,
    // always, also under the dev server: its development JSX needs a development React, and this bundles the production one
    mode: 'production',
    oxc: { jsx: { runtime: 'automatic', development: false } },
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    resolve: { dedupe: ['react', 'react-dom', 'lucide-react'] },
    build: {
      write: false,
      minify: true,
      assetsInlineLimit: 100_000_000,
      chunkSizeWarningLimit: 100_000,
      lib: { entry: join(host, 'src/frame/runtime.tsx'), formats: ['iife'], name: '__gestaltsRuntimeBundle', fileName: () => 'runtime.js' },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result as Rollup.RollupOutput]).flatMap((r) => r.output);
  const js = outputs.flatMap((o) => (o.type === 'chunk' ? [o.code] : [])).join('\n');
  const css = outputs.flatMap((o) => (o.type === 'asset' && o.fileName.endsWith('.css') ? [String(o.source)] : [])).join('\n');
  return { js, css, version: createHash('sha256').update(js).digest('hex').slice(0, 16) };
}

export function gestaltsPlugins(): PluginOption[] {
  let appRoot = process.cwd();
  /** a build for Node (a prerenderer's): no frames run there, and the client build ships the files */
  let ssr = false;
  let runtime: Promise<{ js: string; css: string; version: string }> | undefined;
  /** npm bundles of pinned distributions: their cache files, by their file in the build */
  const npmFiles = new Map<string, string>();
  /** outlines with their views, by name, as the last load of a registry worked them out */
  const outlineFiles = new Map<string, BuiltOutline>();
  const sources: Plugin = {
    name: 'gestalts-sources',
    enforce: 'pre',
    configResolved(config) {
      const names = config.plugins.map((p) => p.name);
      const tailwind = names.findIndex((n) => n.startsWith('@tailwindcss/vite'));
      if (tailwind !== -1 && tailwind < names.indexOf('gestalts-sources')) throw new Error('list gestaltsPlugins() before tailwindcss() in vite.config.ts');
    },
    transform(code, id) {
      if (!/\.css(\?|$)/.test(id) || !SOURCES.test(code)) return;
      const dirs = [...gestaltsPackages(appRoot).map((d) => join(d, 'src')).filter((d) => existsSync(d)), ...appPlugins(appRoot).map((p) => join(p.root, 'view.tsx'))];
      return code.replace(SOURCES, dirs.map((d) => `@source ${JSON.stringify(d)};`).join('\n'));
    },
  };
  const registry: Plugin = {
    name: 'gestalts-plugins',
    config(config) {
      const root = resolve(config.root ?? process.cwd());
      const allow = [...new Set([root, ...gestaltsPackages(root)].map((dir) => searchForWorkspaceRoot(dir)))];
      // the core runs in a module worker (`@gestalts/client`'s core.worker.ts), which imports the wasm
      return { resolve: { dedupe: ['react', 'react-dom', 'lucide-react'] }, server: { fs: { allow } }, worker: { format: 'es' } };
    },
    configResolved(config) { appRoot = config.root; ssr = !!config.build.ssr; },
    resolveId(id) {
      if (id === RUNTIME) return `\0${RUNTIME}`;
      return id === VIRTUAL || id.startsWith(`${VIRTUAL}/`) ? `\0${id}` : undefined;
    },
    async load(id) {
      if (id === `\0${RUNTIME}`) {
        if (ssr) return `export const runtime = ${JSON.stringify({ js: '', css: '', version: 'ssr' })};\n`;
        runtime ??= buildRuntime(appRoot);
        return `export const runtime = ${JSON.stringify(await runtime)};\n`;
      }
      if (id !== RESOLVED && !id.startsWith(`${RESOLVED}/`)) return;
      const name = id.slice(RESOLVED.length + 1);
      const files = distributionFiles(appRoot);
      const file = files.get(name);
      if (!file) throw new Error(`${id.slice(1)}: the app has no such distribution (it has ${[...files.keys()].map((n) => (n ? `${VIRTUAL}/${n}` : VIRTUAL)).join(', ')})`);
      loadApp(appRoot);
      const { distribution, plugins, models, pinned, outlines } = loadDistribution(file);
      const npmUrls = pinned ? await bundleNpm(plugins, npmFiles) : {};
      this.addWatchFile(file);
      for (const m of models) for (const f of subdirs(m.root).flatMap(definitionsIn)) this.addWatchFile(f);
      const entries = plugins.map((p) => {
        this.addWatchFile(join(p.root, 'plugin.yml'));
        this.addWatchFile(join(p.root, 'view.tsx'));
        for (const f of existsSync(join(p.root, 'wording')) ? readdirSync(join(p.root, 'wording')) : []) this.addWatchFile(join(p.root, 'wording', f));
        const decks = p.decks.map((d) => ({ id: d.id, title: d.title, source: `${p.id}/${d.id}`, path: `decks/${p.id}/${d.id}`, practises: d.practises, ...(d.lang ? { lang: d.lang } : {}), ...(d.targetLang ? { targetLang: d.targetLang } : {}) }));
        return { manifest: p.manifest, decks, wording: p.wording, js: p.js, npm: p.npm, npmUrls: npmUrls[p.id], granted: p.granted, backend: p.backend };
      });
      const gestalts = models.flatMap((m) => m.texts);
      for (const o of outlines) this.addWatchFile(join(o.root, 'index.json'));
      for (const p of plugins) for (const d of p.decks) this.addWatchFile(join(d.dir, 'index.json'));
      const built = await buildOutlines(outlines, plugins.flatMap((p) => p.decks.map((d) => ({ source: `${p.id}/${d.id}`, dir: d.dir }))));
      for (const b of built) outlineFiles.set(b.summary.name, b);
      const summaries = built.map((b) => b.summary);
      return `import { runtime } from ${JSON.stringify(RUNTIME)};\nexport const registry = { ...${JSON.stringify({ distribution, plugins: entries, gestalts, outlines: summaries })}, runtime };\n`;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0];
        const bundled = npmFiles.get(path.slice(1));
        if (bundled) { res.setHeader('content-type', 'text/javascript'); res.end(readFileSync(bundled)); return; }
        const outline = /^\/outlines\/([a-z0-9-]+)(\.gaps)?\.json$/.exec(path);
        if (outline) {
          const o = outlineFiles.get(outline[1]);
          if (!o) { res.statusCode = 404; res.end(); return; }
          res.setHeader('content-type', 'application/json');
          res.end(outline[2] ? o.gaps : o.json);
          return;
        }
        const m = /^\/decks\/([a-z0-9.-]+)\/([a-z0-9.-]+)\/(.+)$/.exec(path);
        if (!m) return next();
        const d = appPlugins(appRoot).find((x) => x.id === m[1])?.decks.find((x) => x.id === m[2]);
        if (d && m[3] === 'ymls.json') { res.setHeader('content-type', 'application/json'); res.end(deckBundle(d.dir)); return; }
        const file = d && resolve(d.dir, decodeURIComponent(m[3]));
        if (!d || !file || !file.startsWith(d.dir + '/') || !existsSync(file)) { res.statusCode = 404; res.end(); return; }
        res.end(readFileSync(file));
      });
    },
    async generateBundle() {
      if (ssr) return;
      // the frame runtime this build carries, by version, for whatever serves builds by it (the lesson player)
      if (runtime) this.emitFile({ type: 'asset', fileName: 'gestalts-runtime.json', source: `${JSON.stringify({ version: (await runtime).version })}\n` });
      for (const [file, from] of npmFiles) this.emitFile({ type: 'asset', fileName: file, source: readFileSync(from) });
      for (const [name, o] of outlineFiles) {
        this.emitFile({ type: 'asset', fileName: `outlines/${name}.json`, source: o.json });
        this.emitFile({ type: 'asset', fileName: `outlines/${name}.gaps.json`, source: o.gaps });
      }
      for (const p of appPlugins(appRoot)) {
        for (const d of p.decks) {
          for (const f of files(d.dir)) {
            this.emitFile({ type: 'asset', fileName: `decks/${p.id}/${d.id}/${relative(d.dir, f)}`, source: readFileSync(f) });
          }
          this.emitFile({ type: 'asset', fileName: `decks/${p.id}/${d.id}/ymls.json`, source: deckBundle(d.dir) });
        }
      }
    },
  };
  return [sources, registry];
}
