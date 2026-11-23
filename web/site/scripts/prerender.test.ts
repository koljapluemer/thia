import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { registry } from 'virtual:gestalts-plugins';
import type { OutlineTree, OutlineTreeEntry } from '@gestalts/host';
import { checkTemplate, fill, playerPage } from './pages.ts';
import { ENTRIES } from '../src/Catalog';
import { head, render, routes } from '../src/entry-server';
import { loadOutline } from './test-outlines.ts';

const trees: OutlineTree[] = await Promise.all((registry.outlines ?? []).map((o) => loadOutline(o.name)));
const walk = (es: OutlineTreeEntry[]): OutlineTreeEntry[] => es.flatMap((e) => [e, ...walk(e.entries ?? [])]);
const template = checkTemplate(readFileSync(join(import.meta.dirname, '../index.html'), 'utf8'));

describe('the prerendered site', () => {
  test('has a page for everything, each view and each outline entry', () => {
    const all = routes(trees);
    expect(all).toContain('/');
    for (const e of ENTRIES) expect(all).toContain(e.path);
    for (const t of trees) {
      expect(all).toContain(`/o/${t.name}`);
      expect(all.filter((p) => p.startsWith(`/o/${t.name}/`))).toHaveLength(walk(t.entries).length);
    }
    expect(new Set(all).size).toBe(all.length);
  });

  test('renders the catalog with its views', () => {
    const html = render('/');
    for (const e of ENTRIES.slice(0, 5)) expect(html).toContain(e.title.replaceAll('&', '&amp;'));
  });

  test("renders an outline entry's page open at that entry, in the outline's language", () => {
    const t = trees[0];
    const leaf = walk(t.entries).find((e) => e.views.length > 0)!;
    const path = `/o/${t.name}/${leaf.id.slice('outline-entry-'.length)}`;
    const html = render(path, t);
    expect(html).toContain(`id="${leaf.id}"`);
    expect(html).toContain(`aria-expanded="true"`);
    const h = head(path, trees, 'https://thia.example');
    expect(h.lang).toBe(t.lang.split('-')[0]);
    expect(h.title).toContain(leaf.label.slice(0, 20));
  });

  test("says what a view practises, and where it fits in the outlines", () => {
    const aligned = ENTRIES.find((e) => e.deck && trees.some((t) => walk(t.entries).some((x) => x.views.some((v) => v.source === e.deck!.source))))!;
    const h = head(aligned.path, trees, 'https://thia.example');
    const ld = h.jsonLd as { '@type': string; url: string; educationalAlignment: { targetUrl: string }[] };
    expect(ld['@type']).toBe('LearningResource');
    expect(ld.url).toBe(`https://thia.example${aligned.path}`);
    expect(ld.educationalAlignment.length).toBeGreaterThan(0);
    expect(ld.educationalAlignment[0].targetUrl).toMatch(/^https:\/\/thia\.example\/o\//);
  });

  test('fills the page in, and leaves the player bare and unindexed', () => {
    const page = fill(template, '<main>$& here</main>', { title: 'A <b> & $1', description: 'say "this"', lang: 'de', path: '/x' }, 'https://thia.example');
    expect(page).toContain('<div id="app"><main>$& here</main></div>');
    expect(page).toContain('<title>A &lt;b&gt; &amp; $1</title>');
    expect(page).toContain('content="say &quot;this&quot;"');
    expect(page).toContain('<html lang="de">');
    expect(page).toContain('<link rel="canonical" href="https://thia.example/x">');
    const player = playerPage(template);
    expect(player).toContain('<div id="app"></div>');
    expect(player).toContain('<meta name="robots" content="noindex, nofollow">');
  });
});
