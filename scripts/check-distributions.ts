// Every app's distribution.yml (or distributions/<name>.yml) names plugins from the repo's plugins/ (or the app's own
// plugins/) and model packages from the repo's gestalts/, never another app's files: the contract no import checker
// sees. Exits non-zero, listing what's wrong.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '..');
const plugins = join(root, 'plugins');
const gestalts = join(root, 'gestalts');
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
  const d = (parse(readFileSync(file, 'utf8')) ?? {}) as { core?: string[]; plugins?: string[]; models?: string[] };
  for (const entry of [...(d.core ?? []), ...(d.plugins ?? [])]) {
    const path = resolve(app, entry);
    const where = relative(root, file);
    if (!inside(plugins, path) && !inside(own, path)) problems.push(`${where}: ${entry} is outside plugins/ and the app's own plugins/`);
    else if (!existsSync(join(path, 'plugin.yml'))) problems.push(`${where}: ${entry} has no plugin.yml`);
  }
  for (const entry of d.models ?? []) {
    const path = resolve(app, entry);
    const where = relative(root, file);
    if (dirname(path) !== gestalts) problems.push(`${where}: model ${entry} is not a package in gestalts/`);
    else if (!isPackage(path)) problems.push(`${where}: model ${entry} is not a package (gestalts/<package>/<name>/v<N>.yml)`);
  }
}
// a lesson made in the teacher app is checked by the server and runs on the site: the server knows the teacher app's
// models, and the site has at least those
const models = (file: string) => (((parse(readFileSync(join(web, file), 'utf8')) ?? {}) as { models?: string[] }).models ?? []).map((m) => m.split('/').pop() ?? m).sort();
const server = /pub const MODELS: &\[&str\] = &\[([^\]]*)\]/.exec(readFileSync(join(root, 'web/server/src/lib.rs'), 'utf8'))?.[1].split(',').map((m) => m.trim().replaceAll('"', '')).filter(Boolean).sort().join(', ');
const teacher = models('app/distributions/teacher.yml');
const site = models('site/distribution.yml');
if (teacher.join(', ') !== server) problems.push(`the web app's teacher area (${teacher.join(', ')}) and web/server's MODELS (${server}) must name the same models`);
const missing = teacher.filter((m) => !site.includes(m));
if (missing.length) problems.push(`the site (web/site/distribution.yml) plays teachers' lessons, so it needs their models too: ${missing.join(', ')}`);
for (const p of problems) console.error(p);
if (problems.length) process.exit(1);
console.log('distributions: every plugin in plugins/, every model in gestalts/');
