import { toBase64 } from '../base64';

/**
 * What an agent works against, sent with every turn and loaded on the first one, not with the page. A view's: the
 * contract (`agent-template/CLAUDE.md`), the examples, and the sources of what a view may import, where the contract
 * says (`node_modules/@gestalts/<package>/src/`). A viz's: `@gestalts/viz`'s contract (`packages/viz/agent/CLAUDE.md`),
 * the finished examples with what they were made from, and its sources (`viz-sources/`).
 */
export type Template = { files: Record<string, string>; binary: Record<string, string> };

const viewContract = import.meta.glob('../../agent-template/CLAUDE.md', { query: '?raw', import: 'default' });
const viewExamples = import.meta.glob('../../agent-template/examples/**/*', { query: '?raw', import: 'default' });
const viewSources = import.meta.glob(
  ['../../../view/src/**/*.{ts,tsx}', '../../../kit/src/**/*.{ts,tsx}', '../../../learning/src/**/*.{ts,tsx}', '../../../sources/src/**/*.{ts,tsx}', '!../../../*/src/**/*.test.ts', '!../../../*/src/**/*.test.tsx'],
  { query: '?raw', import: 'default' },
);

const VIZ = '../../../viz/';
const vizContract = import.meta.glob('../../../viz/agent/CLAUDE.md', { query: '?raw', import: 'default' });
const vizExamples = import.meta.glob('../../../viz/examples/*/viz.{ts,yml}', { query: '?raw', import: 'default' });
const vizExampleFiles = import.meta.glob('../../../viz/examples/*/files/*', { query: '?url', import: 'default' });
const vizSources = import.meta.glob(['../../../viz/src/*.ts', '!../../../viz/src/*.test.ts'], { query: '?raw', import: 'default' });

type Globbed = Record<string, () => Promise<unknown>>;

async function texts(globbed: Globbed, path: (key: string) => string): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(Object.entries(globbed).map(async ([k, f]) => [path(k), String(await f())] as const)));
}

async function bytes(globbed: Globbed, path: (key: string) => string): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(Object.entries(globbed).map(async ([k, f]) => {
    const r = await fetch(String(await f()));
    return [path(k), toBase64(new Uint8Array(await r.arrayBuffer()))] as const;
  })));
}

/** Loaded once; a failed load is tried again on the next turn. */
function once(load: () => Promise<Template>): () => Promise<Template> {
  let loaded: Promise<Template> | undefined;
  return () => (loaded ??= load().catch((e: unknown) => { loaded = undefined; throw e; }));
}

export const viewTemplate = once(async () => {
  const parts = await Promise.all([
    texts(viewContract, () => 'CLAUDE.md'),
    texts(viewExamples, (k) => k.replace('../../agent-template/', '')),
    texts(viewSources, (k) => k.replace(/^\.\.\/\.\.\/\.\.\/(view|kit|learning|sources)\//, 'node_modules/@gestalts/$1/')),
  ]);
  return { files: Object.assign({}, ...parts) as Record<string, string>, binary: {} };
});

export const vizTemplate = once(async () => {
  const [contract, examples, sources, binary] = await Promise.all([
    texts(vizContract, () => 'CLAUDE.md'),
    texts(vizExamples, (k) => k.replace(VIZ, '')),
    texts(vizSources, (k) => k.replace(`${VIZ}src/`, 'viz-sources/')),
    bytes(vizExampleFiles, (k) => k.replace(VIZ, '')),
  ]);
  return { files: { ...contract, ...examples, ...sources }, binary };
});
