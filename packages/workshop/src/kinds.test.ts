import { describe, expect, it } from 'vitest';
import { BRIEF, contracts, systemOf } from './agents/kinds';
import { packagesJson } from './viz';

const kept = (keep: string, path: string) => new RegExp(`^(?:${keep})$`).test(path);

describe('the kinds an agent works on', () => {
  it("keeps a view's files and nothing else", () => {
    for (const p of ['view.tsx', 'view.json', 'gestalts/noun@1.yml', 'data/haus.yml']) expect(kept(contracts.view.keep, p)).toBe(true);
    for (const p of ['SPEC.md', 'CLAUDE.md', 'gestalts/noun@0.yml', 'data/.hidden.yml', 'data/a/b.yml', 'viz.ts']) expect(kept(contracts.view.keep, p)).toBe(false);
  });

  it("keeps a viz's source and packages, not its brief or files", () => {
    for (const p of ['viz.ts', 'package.json']) expect(kept(contracts.viz.keep, p)).toBe(true);
    for (const p of ['SPEC.md', 'files/data.csv', 'view.tsx', 'viz-sources/math.ts']) expect(kept(contracts.viz.keep, p)).toBe(false);
  });

  it('tells every kind the same brief first', () => {
    expect(BRIEF).toMatch(/teacher/);
    expect(systemOf('view').startsWith(BRIEF)).toBe(true);
    expect(systemOf('viz').startsWith(BRIEF)).toBe(true);
  });

  it("writes a viz's packages as the package.json it reads back", () => {
    expect(JSON.parse(packagesJson(['d3@7.9.0', '@scope/x@1.2.3'])).dependencies).toEqual({ d3: '7.9.0', '@scope/x': '1.2.3' });
  });
});
