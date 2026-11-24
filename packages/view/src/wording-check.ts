/**
 * What's wrong with a view's wordings, as the build (a plugin's `wording/`) and the check (a draft's `data/wording*`)
 * find it alike. Kept apart from `wording.ts`, which every frame loads.
 */
import { argsOf, parseMessage } from './icu.ts';
import type { Wording } from './wording.ts';

/** `problems` fail; `warnings` are said and let be (a key no longer in the source, which its maker may still want). */
export function wordingProblems(wordings: { name: string; wording: Wording }[]): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const sources = wordings.filter((w) => w.wording.layer === 'source');
  if (sources.length !== 1) {
    if (wordings.length) problems.push(sources.length ? `${sources.map((s) => s.name).join(', ')}: one wording is the source, not ${sources.length}` : 'no wording is the source (`layer: source`), in the view\'s own language');
    return { problems, warnings };
  }
  const source = sources[0].wording;
  const args = new Map<string, Map<string, string>>();
  for (const { name, wording } of wordings) {
    try { Intl.getCanonicalLocales(wording.lang); } catch { problems.push(`${name}: lang ${wording.lang} isn't a language tag (BCP 47)`); }
    for (const [key, e] of Object.entries(wording.messages)) {
      let a: Map<string, string>;
      try { a = argsOf(parseMessage(e.text)); } catch (err) { problems.push(`${name}: ${key}: ${(err as Error).message}`); continue; }
      if (wording.layer === 'source') {
        args.set(key, a);
        if (!e.description?.trim()) problems.push(`${name}: ${key} needs a \`description\`: where it shows and what it's for, for whoever rewords or translates it`);
        continue;
      }
      const of = source.messages[key];
      if (!of) { warnings.push(`${name}: ${key} is no longer in the source (${sources[0].name})`); continue; }
      if (!e.source) problems.push(`${name}: ${key} doesn't say which source text it was written against (\`source\`, its hash)`);
      let want: Map<string, string> | undefined;
      try { want = argsOf(parseMessage(of.text)); } catch { continue; }
      const missing = [...want.keys()].filter((k) => !a.has(k));
      const extra = [...a.keys()].filter((k) => !want.has(k));
      if (missing.length || extra.length) problems.push(`${name}: ${key} takes ${[...a.keys()].map((k) => `{${k}}`).join(' ') || 'nothing'}, its source ${[...want.keys()].map((k) => `{${k}}`).join(' ') || 'nothing'}`);
    }
  }
  return { problems, warnings };
}
