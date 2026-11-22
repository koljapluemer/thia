import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { gestaltsPlugins } from '@gestalts/vite';

// The workshop and its API share an origin (cookies, no CORS): in dev, /api goes to `gestalts-teacher serve`.
const api = process.env.VITE_TEACHER_API ?? 'http://127.0.0.1:7740';

export default defineConfig({
  server: { port: 5173, proxy: { '/api': api } },
  preview: { port: 4173, proxy: { '/api': api } },
  plugins: [gestaltsPlugins(), react(), tailwindcss()],
  // the check's typecheck runs in a worker the dev server's scan doesn't follow: found only at the agent's first check,
  // its dependency would be optimized then, and the dev server reloads the page, ending the agent's turn
  optimizeDeps: { include: ['@gestalts/check > typescript-js', '@gestalts/check > esbuild-wasm'] },
  // the areas are paths (/notes, /learn, …), so everything is from the root
  base: '/',
});
