/** For tests: the site's outline trees as the build makes them (`dist/outlines/<name>.json`), without a build. */
import { join } from 'node:path';
import type { OutlineTree } from '@gestalts/host';
import { loadDistribution } from '@gestalts/vite';
import { buildOutlines } from '@gestalts/vite/outlines';

let built: Promise<Map<string, OutlineTree>> | undefined;

export async function loadOutline(name: string): Promise<OutlineTree> {
  built ??= (async () => {
    const { outlines, plugins } = loadDistribution(join(import.meta.dirname, '../distribution.yml'));
    const all = await buildOutlines(outlines, plugins.flatMap((p) => p.decks.map((d) => ({ source: `${p.id}/${d.id}`, dir: d.dir }))));
    return new Map(all.map((o) => [o.summary.name, JSON.parse(o.json) as OutlineTree]));
  })();
  const tree = (await built).get(name);
  if (!tree) throw new Error(`no outline ${name}`);
  return tree;
}
