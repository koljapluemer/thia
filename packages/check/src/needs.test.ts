/**
 * Each package's `needs.ts` is exactly what its parts read: for every part it exports, everything its code reaches (in
 * the package, or in @gestalts/sources) is followed, symbol by symbol, and the gestalts it names (`'note@1'`,
 * `'pkg/name@1'` as string literals) are what it reads. So name gestalts as literals, best as module-level constants,
 * never built from pieces. Writes can't be told from reads by their names: they're declared by hand, and the host
 * reports one that wasn't (`kind: 'access'`).
 */
import { join, sep } from 'node:path';
import ts from 'typescript-js';
import { describe, expect, it } from 'vitest';
import { NEEDS as KIT } from '@gestalts/kit/needs';
import { NEEDS as LEARNING } from '@gestalts/learning/needs';
import type { Needs } from '@gestalts/view/needs';

const root = join(import.meta.dirname, '../../..');
const GESTALT = /^[a-z][a-z0-9-]*(?:\/[a-z0-9-]+)?@\d+$/;

/** What each value export of `pkg`'s `src/index.ts` reaches, by gestalt. */
function reached(pkg: string): Map<string, Set<string>> {
  const entry = join(root, 'packages', pkg, 'src/index.ts');
  const config = ts.readConfigFile(join(root, 'packages', pkg, 'tsconfig.json'), ts.sys.readFile);
  const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, join(root, 'packages', pkg));
  const program = ts.createProgram([entry], { ...options, noEmit: true, types: [] });
  const checker = program.getTypeChecker();
  // followed into: the package's own code and the sources helpers it builds on
  const followed = [join(root, 'packages', pkg, 'src') + sep, join(root, 'packages/sources/src') + sep];
  const inScope = (f: ts.SourceFile) => !f.isDeclarationFile && followed.some((d) => f.fileName.startsWith(d));

  const memo = new Map<ts.Node, Set<string>>();
  const reach = (decl: ts.Node, seen: Set<ts.Node>, out: Set<string>) => {
    if (seen.has(decl)) return;
    seen.add(decl);
    const visit = (n: ts.Node) => {
      // types name gestalts without touching them
      if (ts.isTypeNode(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n) || ts.isImportDeclaration(n)) return;
      if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && GESTALT.test(n.text)) out.add(n.text);
      if (ts.isIdentifier(n)) {
        let sym = checker.getSymbolAtLocation(n);
        if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
        for (const d of sym?.declarations ?? []) if (inScope(d.getSourceFile())) reach(d, seen, out);
      }
      ts.forEachChild(n, visit);
    };
    visit(decl);
  };

  const sf = program.getSourceFile(entry)!;
  const exports = checker.getExportsOfModule(checker.getSymbolAtLocation(sf)!);
  const out = new Map<string, Set<string>>();
  for (const e of exports) {
    const target = e.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(e) : e;
    if (!(target.flags & ts.SymbolFlags.Value)) continue;
    const gestalts = new Set<string>();
    for (const d of target.declarations ?? []) {
      let set = memo.get(d);
      if (!set) { set = new Set(); reach(d, new Set(), set); memo.set(d, set); }
      set.forEach((g) => gestalts.add(g));
    }
    out.set(e.name, gestalts);
  }
  return out;
}

function problems(pkg: string, needs: Needs): string[] {
  const found = reached(pkg);
  const out: string[] = [];
  const sorted = (s: Iterable<string>) => [...s].sort().join(', ');
  for (const [name, gestalts] of found) {
    const need = needs[name];
    if (!gestalts.size && !need) continue;
    if (!need) out.push(`${name} reads ${sorted(gestalts)}: list it in needs.ts`);
    else if (sorted(need.reads.flat()) !== sorted(gestalts)) out.push(`${name} reads ${sorted(gestalts) || 'nothing'}, needs.ts says ${sorted(need.reads.flat()) || 'nothing'}`);
  }
  for (const [name, need] of Object.entries(needs)) {
    if (!found.has(name)) out.push(`needs.ts lists ${name}, which ${pkg} doesn't export`);
    const reads = need.reads.flat();
    for (const g of (need.writes ?? []).flat()) if (!reads.includes(g)) out.push(`${name} writes ${g}, so it reads it too`);
  }
  return out;
}

describe("each package's needs.ts", () => {
  it('lists what every part of the kit reads', () => expect(problems('kit', KIT)).toEqual([]), 60_000);
  it('lists what every part of learning reads', () => expect(problems('learning', LEARNING)).toEqual([]), 60_000);
});
