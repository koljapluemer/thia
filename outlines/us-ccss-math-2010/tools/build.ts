// Rewrites this outline's notes/ from the Common Core State Standards for Mathematics as a CASE package (CCSSO's, as
// OpenSALT serves it): the Standards for Mathematical Practice, then grades K–8 and the high-school conceptual
// categories, each › domain › cluster › standard › component, with the official codes as `notation`. Concepts come
// from tools/concepts.yml, by an entry's code (or, for one without, its labels from the top joined by ` › `).
//
//   node outlines/us-ccss-math-2010/tools/build.ts [package.json]
//   mise run publish-data outlines/us-ccss-math-2010
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type Node, readMapping, write } from '../../lib/outline.ts';

const DIR = resolve(import.meta.dirname, '..');
const PACKAGE_URL = 'https://opensalt.net/cfpackage/doc/1912.json';
const NOTICE = '© Copyright 2010. National Governors Association Center for Best Practices and Council of Chief State School Officers. All rights reserved.';

type Item = { identifier: string; fullStatement: string; humanCodingScheme?: string; listEnumeration?: string; CFItemType?: string };
type Package = { CFDocument: { identifier: string }; CFItems: Item[]; CFAssociations: { associationType: string; originNodeURI: { identifier: string }; destinationNodeURI: { identifier: string } }[] };

const pkg = (process.argv[2]
  ? JSON.parse(readFileSync(process.argv[2], 'utf8'))
  : await (await fetch(PACKAGE_URL)).json()) as Package;
const items = new Map(pkg.CFItems.map((i) => [i.identifier, i]));
const children = new Map<string, Item[]>();
for (const a of pkg.CFAssociations.filter((a) => a.associationType === 'isChildOf')) {
  const child = items.get(a.originNodeURI.identifier);
  if (!child) continue;
  const list = children.get(a.destinationNodeURI.identifier) ?? [];
  list.push(child);
  children.set(a.destinationNodeURI.identifier, list);
}

/** By code where there is one (the package's enumeration is sometimes off), part by part, numbers as numbers. */
function order(a: Item, b: Item): number {
  const parts = (i: Item) => (i.humanCodingScheme ?? i.listEnumeration ?? '').replace(/\.$/, '').split(/[.-]/);
  const [pa, pb] = [parts(a), parts(b)];
  for (let k = 0; k < Math.max(pa.length, pb.length); k++) {
    const [x, y] = [pa[k] ?? '', pb[k] ?? ''];
    const c = /^\d+$/.test(x) && /^\d+$/.test(y) ? Number(x) - Number(y) : x.localeCompare(y);
    if (c) return c;
  }
  return 0;
}

const SUP: Record<string, string> = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '+': '⁺', '-': '⁻', '−': '⁻', '(': '⁽', ')': '⁾', n: 'ⁿ', x: 'ˣ', i: 'ⁱ', t: 'ᵗ', k: 'ᵏ', m: 'ᵐ', a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ', e: 'ᵉ', p: 'ᵖ', r: 'ʳ', s: 'ˢ', y: 'ʸ', ' ': '' };
// digits only: Unicode has no subscript y, so letters (v_x, v_y) stay alike
const SUB: Record<string, string> = { 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉' };
/** in Unicode's small characters where it has them all, else as `^x` / `^(…)` */
const script = (s: string, table: Record<string, string>, mark: string) =>
  [...s].every((c) => c in table) ? [...s].map((c) => table[c]).join('') : s.length === 1 ? `${mark}${s}` : `${mark}(${s})`;
/** one side of a fraction, closed where the package leaves a parenthesis open, bracketed where it has parts */
const side = (s: string) => {
  let t = s.trim();
  while ((t.match(/\(/g) ?? []).length > (t.match(/\)/g) ?? []).length) t += ')';
  return /[\s/+−-]/.test(t) ? `(${t})` : t;
};
/** the package's statements as plain text: its HTML (emphasis, fractions, super- and subscripts) and entities resolved */
const text = (s: string) => s
  .replace(/<sup>(.*?)<\/sup>\s*\/\s*<sub>(.*?)<\/sub>/g, (_, a: string, b: string) => `${side(a)}/${side(b)}`)
  .replace(/<sup>(.*?)<\/sup>/g, (_, x: string) => script(x, SUP, '^'))
  .replace(/<sub>(.*?)<\/sub>/g, (_, x: string) => script(x, SUB, '_'))
  .replace(/<\/?em>/g, '')
  // a control character where the standards print ≈ (HSA-SSE.B.3.c); no other belongs in a label
  .replace(/\u0098/g, '≈')
  .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ').trim();
const KINDS: Record<string, string> = { 'Grade Level': 'grade', 'Conceptual Category': 'conceptual category', Domain: 'domain', Cluster: 'cluster', Standard: 'standard', Component: 'component' };
const counts: Record<string, number> = {};

function node(i: Item, path: string[], extra: Partial<Node> = {}): Node {
  const label = text(i.fullStatement);
  const kind = i.CFItemType ? KINDS[i.CFItemType] : undefined;
  if (!kind) throw new Error(`${label}: an item of type ${i.CFItemType}`);
  counts[kind] = (counts[kind] ?? 0) + 1;
  const here = [...path, label];
  return {
    label,
    ...(i.humanCodingScheme ? { notation: i.humanCodingScheme } : {}),
    kind,
    key: i.humanCodingScheme ?? here.join(' › '),
    ...extra,
    children: (children.get(i.identifier) ?? []).sort(order).map((c) => node(c, here)),
  };
}

const top = (children.get(pkg.CFDocument.identifier) ?? []);
const wrapper = (label: string) => {
  const w = top.find((i) => text(i.fullStatement) === label);
  if (!w) throw new Error(`no "${label}" in the package`);
  return (children.get(w.identifier) ?? []).sort(order);
};
const GRADES = ['Kindergarten', ...Array.from({ length: 8 }, (_, k) => `Grade ${k + 1}`)];
const practice = wrapper('Standards for Mathematical Practice');
const grades = wrapper('Standards for Math Content');
const categories = wrapper('Standards for HS Math Content');
if (grades.map((g) => text(g.fullStatement)).join('|') !== GRADES.join('|')) throw new Error(`grades: ${grades.map((g) => g.fullStatement).join(', ')}`);

const tree: Node[] = [
  {
    label: 'Standards for Mathematical Practice',
    kind: 'practices',
    key: 'Standards for Mathematical Practice',
    children: practice.map((p) => node(p, ['Standards for Mathematical Practice'], { kind: 'practice' })),
  },
  ...grades.map((g, k) => node(g, [], { grades: [k], isced: k <= 5 ? 1 : 2, level: text(g.fullStatement) })),
  ...categories.map((c) => node(c, ['High School'], { grades: [9, 10, 11, 12], isced: 3, level: 'High School' })),
];
// the 2010 standards as the package has them
// (the 8 practices are standards in the package)
const want = { grade: 9, 'conceptual category': 5, domain: 65, cluster: 147, standard: 393, component: 124 };
for (const [k, n] of Object.entries(want)) if ((counts[k] ?? 0) !== n) throw new Error(`${counts[k] ?? 0} ${k} items, not ${n}: ${JSON.stringify(counts)}`);

write(
  DIR,
  {
    name: 'us-ccss-math-2010',
    title: 'Common Core State Standards for Mathematics',
    lang: 'en',
    issuer: 'National Governors Association Center for Best Practices, Council of Chief State School Officers',
    region: 'US',
    subject: 'Mathematics',
    edition: '2010',
    valid_from: '2010',
  },
  tree,
  {
    id: 'source-us-ccss-math-2010',
    gestalt: 'source@1',
    key: 'ccss2010math',
    entrytype: 'report',
    title: 'Common Core State Standards for Mathematics',
    organization: ['National Governors Association Center for Best Practices', 'Council of Chief State School Officers'],
    location: ['Washington, D.C.'],
    date: '2010',
    url: 'https://www.thecorestandards.org/Math/',
    extra: `${NOTICE} Taken from the CASE package ${PACKAGE_URL}.`,
  },
  readMapping(join(DIR, 'tools/concepts.yml')),
);
