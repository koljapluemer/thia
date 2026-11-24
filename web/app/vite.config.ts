import { defineConfig } from 'vite';
import { execFileSync } from 'node:child_process';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { gestaltsPlugins } from '@gestalts/vite';

// The workshop and its API share an origin (cookies, no CORS): in dev, /api goes to `thia-server serve`, and so do
// what a chat app reaches it at (MCP) and signs in with, at the root (web/server/doc/mcp.md).
const api = process.env.VITE_THIA_API ?? 'http://127.0.0.1:7740';
// the host as the browser or chat app asked for it goes along (a target as a string would be sent the server's own),
// so the sign-in metadata names this origin, the tunnel's when there is one
const asked = { target: api, changeOrigin: false, xfwd: true };
const proxy = { '/api': api, '/mcp': asked, '/oauth': asked, '/.well-known/oauth-': asked };
// a tunnel's host, to try a chat app against this dev server: Cloudflare's quick tunnels always (their names are
// Cloudflare's, so no one can point one at this machine), any other with `THIA_DEV_HOST=<host>`
const allowedHosts = ['.trycloudflare.com', ...(process.env.THIA_DEV_HOST ? [process.env.THIA_DEV_HOST] : [])];
const git = (args: string[]) => { try { return execFileSync('git', args, { encoding: 'utf8' }).trim(); } catch { return ''; } };
const commit = process.env.GESTALTS_GIT_COMMIT ?? git(['rev-parse', 'HEAD']);
const dirty = process.env.GESTALTS_GIT_DIRTY ? process.env.GESTALTS_GIT_DIRTY === 'true' : Boolean(git(['status', '--porcelain']));
const build = { commit: commit || undefined, tag: process.env.GESTALTS_BUILD || undefined, dirty };

export default defineConfig(({ command }) => ({
  server: { port: 5173, proxy, allowedHosts },
  preview: { port: 4173, proxy, allowedHosts },
  plugins: [gestaltsPlugins(), react(), tailwindcss()],
  define: { __GESTALTS_BUILD__: JSON.stringify(build) },
  // the check's typecheck runs in a worker the dev server's scan doesn't follow: found only at the agent's first check,
  // its dependency would be optimized then, and the dev server reloads the page, ending the agent's turn
  optimizeDeps: { include: ['@gestalts/check > typescript-js', '@gestalts/check > esbuild-wasm'] },
  // deployed beside the use app (web/site) on one origin, its files under /make/ (the server's Caddyfile serves its
  // page for /workshop, /review and /runs); in dev it's on its own, from the root. index.html's <base> follows it
  base: command === 'build' ? '/make/' : '/',
}));
