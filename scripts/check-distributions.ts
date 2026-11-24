// Every app's distribution.yml (or distributions/<name>.yml) names plugins from the repo's plugins/ (or the app's own
// plugins/), model packages from the repo's gestalts/ and outlines from the repo's outlines/, never another app's files:
// the contract no import checker sees. Every deck on the public site says what it practises and its language (`deck@4`), so outlines can
// find it. Exits non-zero, listing what's wrong.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '..');
const plugins = join(root, 'plugins');
const gestalts = join(root, 'gestalts');
const outlines = join(root, 'outlines');
const definitions = (dir: string) => readdirSync(dir).filter((f) => /^v\d+\.yml$/.test(f));
// a folder of gestalt folders; one of the core's holds v<N>.yml itself
const isPackage = (dir: string) => existsSync(dir) && definitions(dir).length === 0
  && readdirSync(dir, { withFileTypes: true }).some((e) => e.isDirectory() && definitions(join(dir, e.name)).length > 0);

function distributions(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'gen') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...distributions(p));
    else if (e.name === 'distribution.yml' || (e.name.endsWith('.yml') && dirname(p).endsWith(`${sep}distributions`))) out.push(p);
  }
  return out;
}

const inside = (dir: string, path: string) => path.startsWith(dir + sep);
const problems: string[] = [];
const web = join(root, 'web');
for (const file of distributions(web)) {
  // paths are from the file
  const app = dirname(file);
  const own = join(web, relative(web, app).split(sep)[0], 'plugins');
  const d = (parse(readFileSync(file, 'utf8')) ?? {}) as { id?: string; plugins?: string[]; models?: string[]; outlines?: string[] };
  for (const entry of (d.plugins ?? [])) {
    const path = resolve(app, entry);
    const where = relative(root, file);
    if (!inside(plugins, path) && !inside(own, path)) problems.push(`${where}: ${entry} is outside plugins/ and the app's own plugins/`);
    else if (!existsSync(join(path, 'plugin.yml'))) problems.push(`${where}: ${entry} has no plugin.yml`);
  }
  for (const entry of d.outlines ?? []) {
    const path = resolve(app, entry);
    const where = relative(root, file);
    if (dirname(path) !== outlines) problems.push(`${where}: outline ${entry} is not a folder in outlines/`);
    else if (!existsSync(join(path, 'index.json'))) problems.push(`${where}: outline ${entry} has no index.json (mise run publish-data ${relative(root, path)})`);
  }
  if (d.id === 'site') {
    for (const entry of (d.plugins ?? [])) {
      const decks = join(resolve(app, entry), 'decks');
      if (!existsSync(decks)) continue;
      for (const deck of readdirSync(decks, { withFileTypes: true }).filter((e) => e.isDirectory())) {
        const notes = join(decks, deck.name, 'notes');
        const gestaltOf = (f: string) => /^gestalt:\s*(\S+)/m.exec(readFileSync(join(notes, f), 'utf8'))?.[1];
        const kinds = existsSync(notes) ? readdirSync(notes).filter((f) => f.startsWith('deck-')).map(gestaltOf) : [];
        if (!kinds.includes('deck@4')) problems.push(`${relative(root, file)}: ${relative(root, join(decks, deck.name))} is on the site, so its deck yml is a deck@4 saying what it practises and its language`);
      }
    }
  }
  for (const entry of d.models ?? []) {
    const path = resolve(app, entry);
    const where = relative(root, file);
    if (dirname(path) !== gestalts) problems.push(`${where}: model ${entry} is not a package in gestalts/`);
    else if (!isPackage(path)) problems.push(`${where}: model ${entry} is not a package (gestalts/<package>/<name>/v<N>.yml)`);
  }
}
// a lesson made in the workshop is checked by the server and runs on the site: the server knows the lessons'
// models, and the site has at least those
const models = (file: string) => (((parse(readFileSync(join(web, file), 'utf8')) ?? {}) as { models?: string[] }).models ?? []).map((m) => m.split('/').pop() ?? m).sort();
const server = /pub const MODELS: &\[&str\] = &\[([^\]]*)\]/.exec(readFileSync(join(root, 'web/server/src/lib.rs'), 'utf8'))?.[1].split(',').map((m) => m.trim().replaceAll('"', '')).filter(Boolean).sort().join(', ');
const lessons = models('app/distributions/lessons.yml');
const site = models('site/distribution.yml');
if (lessons.join(', ') !== server) problems.push(`the web app's lesson models (${lessons.join(', ')}) and web/server's MODELS (${server}) must name the same models`);
const missing = lessons.filter((m) => !site.includes(m));
if (missing.length) problems.push(`the site (web/site/distribution.yml) plays published lessons, so it needs their models too: ${missing.join(', ')}`);
for (const p of problems) console.error(p);
if (problems.length) process.exit(1);
console.log('distributions: every plugin in plugins/, every model in gestalts/, every outline in outlines/, every site deck a deck@4');
