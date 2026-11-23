import { defineConfig } from 'oxlint';

/**
 * Who may import whom (eslint-plugin-boundaries):
 * - `@gestalts/viz` (what an interactive visualization is written with, and its runtime) imports nothing of ours.
 * - `@gestalts/view` (what a view gets from the app) imports nothing of ours; `@gestalts/learning` only the view package;
 *   `@gestalts/sources` nothing of ours.
 * - `@gestalts/kit` imports only the view and sources packages, in layers: primitives < components < widgets < perspectives.
 * - a plugin's `view.tsx` imports only the view package, the kit (its index), learning and sources, never another plugin, the
 *   client or the host.
 * - the kit is for views only: the frame runtime (`packages/host/src/frame/runtime.tsx`, everything a frame loads) is the one
 *   thing besides views that imports it, to hand it to them. Hosts and apps are shells and get by with tailwind + daisyUI.
 * - `@gestalts/client` (the core in the browser) builds on the view package; the host on client, view, learning and sources;
 *   the frame runtime also on the kit's index.
 * - `@gestalts/vite` (the build preset, run by Node) imports the view package's compiler, and npm-bundle for pinned
 *   distributions.
 * - `@gestalts/check` (what an agent's work is checked with, in the page and in Node) imports the view and viz packages.
 * - `@gestalts/workshop` (making a view with an agent) builds on client, host, view and check.
 * - `@gestalts/npm-bundle` (npm packages for views, bundled by a server, run by Node) imports only the view package.
 * - an app (`web/<app>/src`, folder-sync's settings page) imports only the packages
 *   (client, host, view, learning, sources, workshop, check) and its own files, never another app or a plugin;
 *   nothing imports an app.
 * External packages are always fine.
 */
const kit = 'packages/kit/src';
const host = 'packages/host/src';
const kitBelow: Record<string, string[]> = {
  primitive: [],
  component: ['primitive'],
  widget: ['component', 'primitive'],
  perspective: ['widget', 'component', 'primitive'],
  'kit-index': ['perspective', 'widget', 'component', 'primitive'],
};
const allowed: Record<string, string[]> = {
  view: [],
  vite: ['view', 'npm-bundle'],
  learning: ['view'],
  sources: [],
  viz: [],
  client: ['view'],
  ...Object.fromEntries(Object.entries(kitBelow).map(([t, below]) => [t, ['view', 'sources', ...below]])),
  plugin: ['view', 'kit-index', 'learning', 'sources'],
  debug: ['client', 'view'],
  host: ['client', 'view', 'learning', 'sources', 'debug'],
  workshop: ['client', 'host', 'view', 'check'],
  check: ['view', 'viz'],
  'npm-bundle': ['view'],
  app: ['client', 'host', 'view', 'learning', 'sources', 'workshop', 'check'],
};

export default defineConfig({
  ignorePatterns: ['**/dist', 'packages/client/wasm', '**/node_modules', '**/decks'],
  plugins: ['typescript', 'react', 'oxc', 'unicorn'],
  jsPlugins: [{ name: 'react-hooks-js', specifier: 'eslint-plugin-react-hooks' }, 'eslint-plugin-boundaries'],
  categories: { correctness: 'error' },
  settings: {
    'import/resolver': { typescript: { project: ['packages/*/tsconfig.json', 'plugins/tsconfig.json', 'web/*/tsconfig.json', 'installables/folder-sync/*/tsconfig.json'] }, node: true },
    'boundaries/elements': [
      { type: 'view', pattern: 'packages/view/src' },
      { type: 'vite', pattern: 'packages/vite/src' },
      { type: 'learning', pattern: 'packages/learning/src' },
      { type: 'sources', pattern: 'packages/sources/src' },
      { type: 'viz', pattern: 'packages/viz/src' },
      { type: 'check', pattern: 'packages/check/src' },
      { type: 'client', pattern: 'packages/client/src' },
      { type: 'primitive', pattern: `${kit}/primitives` },
      { type: 'component', pattern: `${kit}/components` },
      { type: 'widget', pattern: `${kit}/widgets` },
      { type: 'perspective', pattern: `${kit}/perspectives` },
      // files directly in packages/kit/src: the index views import
      { type: 'kit-index', pattern: kit },
      { type: 'plugin', pattern: 'plugins/*', capture: ['plugin'] },
      { type: 'debug', pattern: `${host}/debug` },
      { type: 'host', pattern: host },
      { type: 'workshop', pattern: 'packages/workshop/src' },
      { type: 'npm-bundle', pattern: 'packages/npm-bundle/src' },
      // apps: each its own element, so one may not import another
      { type: 'app', pattern: 'installables/folder-sync/*/src', capture: ['app'] },
      { type: 'app', pattern: 'web/*/src', capture: ['app'] },
    ],
    'boundaries/files': [{ category: 'runtime', pattern: `**/${host}/frame/runtime.tsx` }],
  },
  rules: {
    'react/rules-of-hooks': 'error',
    'react/exhaustive-deps': 'warn',
    'react-hooks-js/set-state-in-render': 'error',
    'react-hooks-js/immutability': 'error',
    'react-hooks-js/refs': 'error',
  },
  overrides: [{
    files: ['packages/*/src/**/*.{ts,tsx}', 'plugins/*/*.{ts,tsx}', 'web/*/src/**/*.{ts,tsx}', 'installables/*/*/src/**/*.{ts,tsx}'],
    rules: {
      'boundaries/no-unknown-files': 'error',
      'boundaries/dependencies': ['error', {
        default: 'disallow',
        policies: [
          { allow: { dependency: { relationship: { to: 'internal' } } } },
          ...Object.entries(allowed).map(([type, to]) => ({
            from: { element: { type } },
            allow: { to: { element: { types: { anyOf: to.length ? to : ['none'] } } } },
          })),
          { from: { file: { categories: 'runtime' } }, allow: { to: { element: { type: 'kit-index' } } } },
        ],
      }],
    },
  }],
});
