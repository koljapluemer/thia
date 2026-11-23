// Every published outline in outlines/, as its builder wrote it: ids by the rule, a tree, concepts shipped and named
// by the rule. (publish-data and health check the tree too, in the core; this also checks what only builders know.)
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Yml = { id: string; gestalt: string; name?: string; label?: string; notation?: string; kind?: string; entries?: string[]; concepts?: Record<string, number>; grades?: number[] };
const sha = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);
const dirs = readdirSync(import.meta.dirname).filter((d) => existsSync(join(import.meta.dirname, d, 'index.json')));

for (const dir of dirs) {
  describe(dir, () => {
    const root = join(import.meta.dirname, dir);
    const files = readdirSync(join(root, 'notes'));
    const ymls = files.map((f) => parse(readFileSync(join(root, 'notes', f), 'utf8')) as Yml);
    const byId = new Map(ymls.map((y) => [y.id, y]));
    const outline = ymls.find((y) => y.gestalt === 'outline@1')!;
    const entries = ymls.filter((y) => y.gestalt === 'outline-entry@1');

    it('is one outline, named by its folder and its id by its name, every yml listed', () => {
      expect(outline.name).toBe(dir);
      expect(outline.id).toBe(`outline-${sha(dir)}`);
      for (const [i, f] of files.entries()) expect(f).toBe(`${ymls[i].id}.yml`);
      expect(new Set((JSON.parse(readFileSync(join(root, 'index.json'), 'utf8')) as { ymls: string[] }).ymls)).toEqual(new Set(ymls.map((y) => y.id)));
      expect(existsSync(join(root, 'README.md'))).toBe(true);
    });

    it('is a tree: every entry under one parent, reachable from the top', () => {
      const parents = new Map<string, number>();
      for (const y of [outline, ...entries]) for (const c of y.entries ?? []) parents.set(c, (parents.get(c) ?? 0) + 1);
      for (const e of entries) expect(parents.get(e.id), e.label).toBe(1);
      const seen = new Set<string>();
      const walk = (id: string) => { seen.add(id); for (const c of byId.get(id)?.entries ?? []) walk(c); };
      walk(outline.id);
      expect(seen.size).toBe(entries.length + 1);
    });

    it('names an entry with a notation by it', () => {
      for (const e of entries.filter((e) => e.notation)) expect(e.id).toBe(`outline-entry-${sha(`${dir}/${e.notation}`)}`);
      const notations = entries.flatMap((e) => (e.notation ? [e.notation] : []));
      expect(new Set(notations).size).toBe(notations.length);
    });

    it('ships every concept it names, each named by the rule, weighted 1, 0.5 or 0.2', () => {
      for (const e of entries) {
        for (const [c, w] of Object.entries(e.concepts ?? {})) {
          const concept = byId.get(c);
          expect(concept?.gestalt, `${e.label}: ${c}`).toMatch(/^concept@[23]$/);
          expect(c).toBe(`concept-${sha(concept!.name!)}`);
          expect([1, 0.5, 0.2]).toContain(w);
        }
      }
    });
  });
}

describe('de-ni-gym-mathe-2015', () => {
  it('has the 22 Lernbereiche, 7, 8 and 7 per Doppelschuljahrgang', () => {
    const notes = join(import.meta.dirname, 'de-ni-gym-mathe-2015/notes');
    const ymls = new Map(readdirSync(notes).map((f) => { const y = parse(readFileSync(join(notes, f), 'utf8')) as Yml; return [y.id, y] as const; }));
    const outline = [...ymls.values()].find((y) => y.gestalt === 'outline@1')!;
    const stages = outline.entries!.map((id) => ymls.get(id)!);
    expect(stages.map((s) => s.grades)).toEqual([[5, 6], [7, 8], [9, 10]]);
    expect(stages.map((s) => s.entries!.filter((id) => ymls.get(id)!.kind === 'Lernbereich').length)).toEqual([7, 8, 7]);
  });
});

describe('us-ccss-math-2010', () => {
  it('starts with the eight practices, then grades K–8, then high school', () => {
    const notes = join(import.meta.dirname, 'us-ccss-math-2010/notes');
    const ymls = new Map(readdirSync(notes).map((f) => { const y = parse(readFileSync(join(notes, f), 'utf8')) as Yml; return [y.id, y] as const; }));
    const outline = [...ymls.values()].find((y) => y.gestalt === 'outline@1')!;
    const top = outline.entries!.map((id) => ymls.get(id)!);
    expect(top[0].entries!.map((id) => ymls.get(id)!.notation)).toEqual(['MP1', 'MP2', 'MP3', 'MP4', 'MP5', 'MP6', 'MP7', 'MP8']);
    expect(top.slice(1, 10).map((g) => g.grades)).toEqual([[0], [1], [2], [3], [4], [5], [6], [7], [8]]);
    expect(top.slice(10).map((c) => c.label)).toEqual(['Number and Quantity', 'Algebra', 'Functions', 'Geometry', 'Statistics & Probability']);
  });
});
