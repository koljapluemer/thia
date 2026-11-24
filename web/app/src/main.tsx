import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { LangProvider } from '@gestalts/i18n';
import { App } from './App';
import './app.css';

// not prerendered: the person's language from the start
createRoot(document.getElementById('app')!).render(<StrictMode><LangProvider><App /></LangProvider></StrictMode>);

// the built app opens offline too: the origin's one service worker, the use app's (web/site/public/sw.js); not in
// development, where Vite serves fresh files
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((e: unknown) => console.warn('gestalts: no offline copy:', e));
}
