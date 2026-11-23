// Prints an outline's tree from its notes/, with the concepts on each entry: for reviewing a mapping.
//
//   node outlines/lib/tree.ts outlines/<name>
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

type Y = { id: string; gestalt?: string; name?: string; label?: string; notation?: string; kind?: string; concepts?: Record<string, number>; entries?: string[] };
const notes = join(process.argv[2] ?? '.', 'notes');
const ymls = new Map(readdirSync(notes).map((f) => { const y = parse(readFileSync(join(notes, f), 'utf8')) as Y; return [y.id, y] as const; }));
const name = (id: string) => ymls.get(id)?.name ?? id;
const show = (id: string, indent: string) => {
  const e = ymls.get(id)!;
  const about = e.concepts ? `  {${Object.entries(e.concepts).map(([c, w]) => `${name(c)}: ${w}`).join(', ')}}` : '';
  console.log(`${indent}${e.notation ? `${e.notation} ` : ''}${e.label}${e.kind ? `  [${e.kind}]` : ''}${about}`);
  for (const c of e.entries ?? []) show(c, `${indent}  `);
};
for (const id of [...ymls.values()].find((y) => y.gestalt === 'outline@1')?.entries ?? []) show(id, '');
