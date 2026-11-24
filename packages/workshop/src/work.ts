import type { Repo } from '@gestalts/client';
import type { Messages } from '@gestalts/i18n';
import type { AgentKind } from './agents/kinds';
import { toBase64 } from './base64';
import { VIEWS, applyFiles, asDraft, filesOf, loadMembers, saveDraft, saveSpec } from './draft';
import { VIZ, asViz, packagesJson, saveViz, storeBlob, type Viz } from './viz';

/**
 * A draft as a conversation works on it, whatever its kind: what the agent is sent, and where what comes back goes.
 * `Chat` knows nothing else of a draft; each kind is one of these.
 */
export type Snapshot = {
  files: Record<string, string>;
  /** read-only files, as base64 */
  binary?: Record<string, string>;
  spec?: string;
  /** the gestalts the app has (`name@N`), which a view may read and write besides its own */
  gestalts: string[];
};

/** What the page's own check said of what a turn left. */
export type Settled = { ok: boolean; text: string; detail?: string };

export type Work = {
  kind: AgentKind;
  id: string;
  /** the draft as the agent sees it now */
  snapshot(): Promise<Snapshot>;
  /** keeps `spec` as the draft's brief, as the draft is now */
  setSpec(spec: string): Promise<void>;
  /** writes what a turn changed (`null`: deleted); what couldn't be saved */
  apply(changed: Record<string, string | null>): Promise<string[]>;
  /**
   * After a turn that changed the draft: the page checks it itself, and keeps what it makes only when that passes. `by`
   * is the agent that made it.
   */
  settle?(by: string): Promise<Settled | undefined>;
};

async function one(repo: Pick<Repo, 'query'>, gestalt: string | string[], id: string) {
  const g = Array.isArray(gestalt) ? gestalt : [gestalt];
  const item = (await repo.query({ ids: [id], limit: 1 })).items.find((i) => g.includes(i.gestalt));
  if (!item) throw new Error(`${id} isn't here any more`);
  return item;
}

/** A view's draft (`view@4` and its members). `runtime` is recorded with each save. */
export function viewWork(repo: Repo, id: string, runtime?: string): Work {
  const read = async () => asDraft(await one(repo, VIEWS, id));
  return {
    kind: 'view',
    id,
    async snapshot() {
      const d = await read();
      const gestalts = (await repo.gestalts()).map((g) => `${g.name}@${g.version}`).filter((g) => !g.startsWith(`${d.package}/`));
      return { files: filesOf(d, await loadMembers(repo, d)), spec: d.spec, gestalts };
    },
    async setSpec(spec) { await saveSpec(repo, await read(), spec); },
    async apply(changed) {
      const d = await read();
      return (await saveDraft(repo, applyFiles(d, await loadMembers(repo, d), changed), runtime)).problems;
    },
  };
}

async function vizBytes(repo: Pick<Repo, 'readBlob'>, v: Viz): Promise<Record<string, Uint8Array>> {
  const out: Record<string, Uint8Array> = {};
  for (const f of v.files) out[`files/${f.label}`] = (await repo.readBlob(f.file)) ?? new Uint8Array();
  return out;
}

/**
 * A visualization's draft (`viz@1`): the agent writes `viz.ts` and `package.json` from its spec, with its files to
 * read. Once a turn changed it, the page builds and renders it itself, and stores the page and its still (blobs named by
 * content) only when that passes; a failed check keeps the source and the last page that passed.
 */
export function vizWork(repo: Repo, id: string): Work {
  const read = async () => asViz(await one(repo, VIZ, id));
  return {
    kind: 'viz',
    id,
    async snapshot() {
      const v = await read();
      const files: Record<string, string> = { 'package.json': packagesJson(v.packages) };
      if (v.source.trim()) files['viz.ts'] = v.source;
      const binary = Object.fromEntries(Object.entries(await vizBytes(repo, v)).map(([p, b]) => [p, toBase64(b)]));
      const spec = v.title ? `# ${v.title}\n\n${v.spec.trim()}` : v.spec;
      return { files, binary, spec, gestalts: [] };
    },
    async setSpec(spec) { await saveViz(repo, { ...(await read()), spec }); },
    async apply(changed) {
      const v = await read();
      const next: Viz = { ...v };
      if ('viz.ts' in changed) next.source = changed['viz.ts'] ?? '';
      const problems: string[] = [];
      if (typeof changed['package.json'] === 'string') {
        const { packagesOf } = await import('@gestalts/check');
        const p = packagesOf(changed['package.json']);
        problems.push(...p.problems);
        if (!p.problems.length) next.packages = Object.entries(p.packages).map(([n, ver]) => `${n}@${ver}`);
      }
      await saveViz(repo, next);
      return problems;
    },
    async settle(by) {
      const v = await read();
      if (!v.source.trim()) return undefined;
      const [{ checkViz }, { browserPlatform }] = await Promise.all([import('@gestalts/check'), import('@gestalts/check/browser')]);
      const r = await checkViz({ ...(await vizBytes(repo, v)), 'viz.ts': v.source, 'package.json': packagesJson(v.packages) }, browserPlatform);
      if (r.ok && r.built) {
        const now = await read();
        await saveViz(repo, {
          ...now,
          built: await storeBlob(repo, new TextEncoder().encode(r.built), 'html'),
          still: r.still ? await storeBlob(repo, r.still, 'png') : undefined,
          generator: by,
        });
      }
      return r.ok
        ? { ok: true, text: 'Built and checked.', detail: r.report }
        : { ok: false, text: 'The check failed: the source is saved, the page shown is the last one that passed.', detail: r.report };
    },
  };
}

/** `work`, with `flush` awaited before the draft is read for a turn: what's typed and not saved yet goes with it. */
export const flushing = (work: Work, flush: () => Promise<void>): Work => ({ ...work, snapshot: async () => { await flush(); return work.snapshot(); } });

/** The one-click messages a draft's chat offers: building from its brief, once there is one. Labels in `m`'s language; what the agent is told in English. */
export const buildActions = (m: Messages, spec: string, built: boolean) => (spec.trim()
  ? [{ label: built ? m.action_rebuild() : m.action_build(), message: built ? 'Build what SPEC.md describes, starting from what is there: keep what works and change what the brief requires.' : 'Build what SPEC.md describes.' }]
  : []);
