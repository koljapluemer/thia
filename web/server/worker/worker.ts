// The teacher server's helper for what only Node does well: checking a draft's view the way the workshop does, and
// bundling npm packages. `gestalts-teacher` runs it as a child and speaks JSON lines with it on stdin/stdout:
// `{id, op, ...}` in, `{id, ok: true, result}` or `{id, ok: false, error}` out, in any order.
//
// - `check {files, gestalts}`: `@gestalts/check`'s `checkView` on the draft as the agent sees it (the one check the
//   page, the agents and publishing all run), plus whether each npm package it pins bundles: `{ok, output, problems}`,
//   `problems` each failing line on its own
// - `check-draft {ymls, view, gestalts}`: the same, on a draft as ymls (publishing, submissions)
// - `check-viz {files, binary}`: `checkViz` on a viz as the agent sees it (`binary`: its `files/`, base64), rendered in
//   headless Chromium (`render.ts`): `{ok, content}`, the report and a screenshot of each size as MCP content
// - `compile {source}`: the view as the frame loads it
// - `npm {specifier, version}`: one bundle, from the cache when it was made before
//
// Env: TEACHER_NPM_CACHE.
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { checkView, checkViz, type Files } from '@gestalts/check';
import { nodePlatform } from '@gestalts/check/node';
import { compile } from '@gestalts/view/compile';
import type { Item, JsonMap } from '@gestalts/view';
import { bundle, isVersion, packageName, resolveVersion } from '@gestalts/npm-bundle';
import { asDraft, filesOf } from '@gestalts/workshop/draft';
import { parse } from 'yaml';
import { render } from './render.ts';

const CACHE = resolve(process.env.TEACHER_NPM_CACHE ?? join(tmpdir(), 'gestalts-npm-cache'));

type Request = { id: number; op: string; [k: string]: unknown };

/** The check, then whether each package the view pins bundles: what only Node can tell. */
async function check(files: Record<string, string>, gestalts: string[]): Promise<{ ok: boolean; output: string; problems: string[] }> {
  const r = await checkView(files, { gestalts }, nodePlatform);
  // the verdict comes last, after the bundles
  const lines = r.report.split('\n').slice(0, -1);
  const npm = await checkBundles(files);
  lines.push(...npm.lines);
  lines.push(r.ok && npm.ok ? '✓ all good' : '✗ not yet: fix the above and check again');
  const problems = [
    ...r.items.filter((i) => !i.ok).flatMap((i) => (i.message?.trim() ? i.message.trim().split('\n').map((l) => l.trim()).filter(Boolean) : [i.name])),
    ...npm.lines.filter((l) => l.startsWith('✗')).map((l) => l.slice(2)),
  ];
  return { ok: r.ok && npm.ok, output: `${lines.join('\n')}\n`, problems };
}

/** Each npm import that view.json pins at an exact version, bundled; the check says what isn't pinned. */
async function checkBundles(files: Record<string, string>): Promise<{ ok: boolean; lines: string[] }> {
  const compiled = compile(files['view.tsx'] ?? '');
  if (!compiled.ok || compiled.npm.length === 0) return { ok: true, lines: [] };
  let declared: Record<string, string> = {};
  try { declared = (JSON.parse(files['view.json'] ?? '{}') as { npm?: Record<string, string> }).npm ?? {}; } catch { /* the check says so */ }
  const lines: string[] = [];
  let ok = true;
  for (const spec of compiled.npm) {
    const name = packageName(spec);
    const version = declared[name ?? ''];
    if (!name || !version || !isVersion(version)) {
      // the check says it isn't pinned; which version is there is only known here
      const latest = name ? await resolveVersion(name, 'latest').catch(() => undefined) : undefined;
      if (latest && isVersion(latest)) lines.push(`  (the latest ${name} is ${latest})`);
      continue;
    }
    try {
      const b = await bundle(spec, version, { cacheDir: CACHE });
      lines.push(`✓ ${spec}@${version} bundles (${Math.round(b.bytes / 1024)} KB)`);
    } catch (e) {
      ok = false;
      lines.push(`✗ ${spec}@${version} doesn't bundle: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  return { ok, lines };
}

/** A draft as ymls (`[{id, text}]`, its view `view` among them) as the agent sees it, as files. */
function draftFiles(ymls: { id: string; text: string }[], view: string): Record<string, string> {
  const items = new Map<string, Item>();
  for (const { id, text } of ymls) {
    const value = parse(text) as JsonMap | null;
    if (value && typeof value === 'object') items.set(id, { id, gestalt: String(value.gestalt ?? ''), value });
  }
  const v = items.get(view);
  if (!v) throw new Error(`no view ${view}`);
  const draft = asDraft(v);
  return filesOf(draft, draft.members.flatMap((m) => items.get(m) ?? []));
}

/** A viz's check with the render, as the agent's `check` tool answers. */
async function checkVizHere(files: Record<string, string>, binary: Record<string, string>) {
  const bytes: Files = Object.fromEntries(Object.entries(binary).map(([p, b64]) => [p, new Uint8Array(Buffer.from(b64, 'base64'))]));
  const r = await checkViz({ ...bytes, ...files }, { ...nodePlatform, render });
  return {
    ok: r.ok,
    content: [{ type: 'text', text: r.report }, ...r.shots.map((s) => ({ type: 'image', data: Buffer.from(s.png).toString('base64'), mimeType: 'image/png' }))],
  };
}

async function handle(req: Request): Promise<unknown> {
  switch (req.op) {
    case 'check': return check(req.files as Record<string, string>, (req.gestalts as string[]) ?? []);
    case 'check-draft': return check(draftFiles(req.ymls as { id: string; text: string }[], String(req.view)), (req.gestalts as string[]) ?? []);
    case 'check-viz': return checkVizHere(req.files as Record<string, string>, (req.binary as Record<string, string>) ?? {});
    case 'compile': return compile(String(req.source ?? ''));
    case 'npm': return bundle(String(req.specifier), String(req.version), { cacheDir: CACHE });
    default: throw new Error(`no op ${req.op}`);
  }
}

const out = (m: unknown) => process.stdout.write(`${JSON.stringify(m)}\n`);
createInterface({ input: process.stdin }).on('line', (line) => {
  let req: Request;
  try { req = JSON.parse(line) as Request; } catch { return; }
  handle(req).then((result) => out({ id: req.id, ok: true, result }), (e: unknown) => out({ id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) }));
});
