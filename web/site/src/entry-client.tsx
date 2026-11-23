import { StrictMode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { ENTRIES } from './Catalog';
import { loadTree, outlineAt } from './Outline';
import { Site, type PageData } from './Site';
import './app.css';

// an `?open=<view>&<params>` link, as the gestalter made them: that view's page, there
const asked = new URLSearchParams(location.search);
const view = asked.get('open');
if (view) {
  asked.delete('open');
  const hash = asked.toString();
  const to = ENTRIES.find((e) => e.plugin.manifest.id === view)?.path ?? '/';
  history.replaceState(null, '', `${to}${hash ? `#${hash}` : ''}`);
}

const root = document.getElementById('app')!;
const app = (data?: PageData) => <StrictMode><Site path={location.pathname} data={data} /></StrictMode>;

/**
 * A prerendered page (scripts/prerender.ts) is taken over as it is, once what it was rendered with is here too; the
 * bare one (the lesson player's, or a path the build didn't know) renders from scratch.
 */
async function start() {
  if (!root.hasChildNodes()) {
    createRoot(root).render(app());
    return;
  }
  const outline = outlineAt(location.pathname);
  const tree = outline ? await loadTree(outline.name).catch(() => undefined) : undefined;
  hydrateRoot(root, app({ tree }));
}
void start();

// the built site opens offline too (public/sw.js); not in development, where Vite serves fresh files
if (import.meta.env.PROD && 'serviceWorker' in navigator && !location.pathname.startsWith('/l/')) {
  navigator.serviceWorker.register('/sw.js').catch((e: unknown) => console.warn('thia: no offline copy:', e));
}
