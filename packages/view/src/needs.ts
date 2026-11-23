/**
 * What the parts of a package views import (`@gestalts/kit`, `@gestalts/learning`) read and write. Such a part runs in
 * the view's frame, so its calls are the view's: a view declares, by hand, every gestalt it touches, its parts' among
 * them. Each package lists its parts' needs in its own `needs.ts`; `packages/check/src/needs.test.ts` keeps those lists
 * exact. Pure data, so the build and the checks import it without React.
 */

/**
 * A gestalt, or a list of which one is enough: what the view passes decides which it is (`logPractice` writes
 * `practice-event@2` only when given what `@1` can't hold).
 */
export type Gestalts = readonly (string | readonly string[])[];
export type Need = { reads: Gestalts; writes?: Gestalts };
export type Needs = Readonly<Record<string, Need>>;

/**
 * One line per part a view imports whose needs its `reads` and `writes` don't cover. `imports`: the parts it imports by
 * name, per package (`compile`'s `imports`); `needs`: each package's list; `manifest`: where reads and writes are
 * declared, as the author should read it (`plugin.yml`, `view.json`).
 */
export function needsProblems({ imports, reads, writes, needs, manifest }: {
  imports: Readonly<Record<string, readonly string[]>>;
  reads: readonly string[];
  writes: readonly string[];
  needs: Readonly<Record<string, Needs>>;
  manifest: string;
}): string[] {
  const out: string[] = [];
  for (const [pkg, names] of Object.entries(imports)) {
    for (const name of names) {
      const need = needs[pkg]?.[name];
      if (!need) continue;
      const missing = (want: Gestalts, have: readonly string[]) => want
        .filter((g) => (typeof g === 'string' ? !have.includes(g) : !g.some((x) => have.includes(x))))
        .map((g) => (typeof g === 'string' ? g : g.join(' or ')));
      const r = missing(need.reads, reads);
      const w = missing(need.writes ?? [], writes);
      if (!r.length && !w.length) continue;
      const what = [r.length ? `reads ${r.join(', ')}` : '', w.length ? `writes ${w.join(', ')}` : ''].filter(Boolean).join(' and ');
      const where = [r.length ? '`reads`' : '', w.length ? '`writes`' : ''].filter(Boolean).join(' and ');
      out.push(`view.tsx uses ${name} (from ${pkg}), which ${what}: add ${r.length + w.length > 1 ? 'them' : 'it'} to ${where} in ${manifest}`);
    }
  }
  return out;
}
