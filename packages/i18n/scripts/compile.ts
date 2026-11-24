/**
 * Compiles messages/<area>/<locale>.json into src/paraglide (Paraglide's typed message functions), after making the
 * pseudo-locale `en-XA` from `en`: every word accented and a third longer, so text the messages don't hold and text
 * that doesn't fit both show in development. Run by `pnpm install` (this package's `prepare`); the plugin is loaded
 * from node_modules, never from a CDN.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compile } from '@inlang/paraglide-js';
import { LOCALES } from '../src/locales.ts';
import { pseudo } from '../src/pseudo.ts';

const root = join(import.meta.dirname, '..');
const messages = join(root, 'messages');
const areas = readdirSync(messages, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();

type Messages = Record<string, unknown>;
// a complex message is [{declarations, selectors, match}]: only the variants' text is made pseudo
const pseudoMessages = (m: Messages): Messages => Object.fromEntries(Object.entries(m).filter(([k]) => k !== '$schema').map(([k, v]) => [k,
  typeof v === 'string' ? pseudo(v)
    : Array.isArray(v) ? v.map((x: { match: Record<string, string> }) => ({ ...x, match: Object.fromEntries(Object.entries(x.match).map(([c, t]) => [c, pseudo(t)])) }))
      : v,
]));

for (const area of areas) {
  const en = JSON.parse(readFileSync(join(messages, area, 'en.json'), 'utf8')) as Messages;
  writeFileSync(join(messages, area, 'en-XA.json'), `${JSON.stringify(pseudoMessages(en), null, 2)}\n`);
}

// the inlang project is made here, as it names the plugin by its path on this machine
mkdirSync(join(root, 'project.inlang'), { recursive: true });
writeFileSync(join(root, 'project.inlang/settings.json'), `${JSON.stringify({
  baseLocale: 'en',
  locales: LOCALES,
  modules: [join(root, 'node_modules/@inlang/plugin-message-format/dist/index.js')],
  'plugin.inlang.messageFormat': { pathPattern: areas.map((a) => `./messages/${a}/{locale}.json`) },
}, null, 2)}\n`);

await compile({
  project: join(root, 'project.inlang'),
  outdir: join(root, 'src/paraglide'),
  // the language is always passed (`{locale}`): never Paraglide's own detection, cookies or async storage
  strategy: ['baseLocale'],
  disableAsyncLocalStorage: true,
  emitTsDeclarations: true,
  emitReadme: false,
  emitGitIgnore: false,
});
