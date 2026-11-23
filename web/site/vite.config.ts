import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { gestaltsPlugins } from '@gestalts/vite';

// A static site: every path is index.html. The lesson domain also serves this build, under /runtime/<version>/ with a
// <base> to there, for every /l/<lesson>; in dev, what it answers comes from the server (VITE_LESSONS, :7741).
// The build's own npm bundles are answered first, by @gestalts/vite; any other /npm/ is a lesson's.
const lessons = process.env.VITE_LESSONS ?? 'http://127.0.0.1:7741';

export default defineConfig({
  server: { port: 5177, proxy: { '^/l/[^/]+/current$': lessons, '/lessons/': lessons, '/npm/': lessons } },
  preview: { port: 4177 },
  plugins: [gestaltsPlugins(), react(), tailwindcss()],
  base: './',
});
