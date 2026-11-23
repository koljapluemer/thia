/**
 * Prerenders the built site (after `vite build` and `vite build --ssr src/entry-server.tsx --outDir dist-ssr`): every
 * page the site has as its own `dist/<path>/index.html`, with its content and what search engines and link previews
 * read in its head, so it shows without JavaScript and is found; the browser then takes it over. Also:
 *
 * - `player.html`: the bare page, for the lesson domain's player (web/server, lessons.rs), never indexed
 * - `404.html`: what a path the site doesn't have shows
 * - with `VITE_PUBLIC_URL` (the site's URL): canonical links, `sitemap.xml` and `robots.txt`
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkTemplate, fill, playerPage, text, type Head } from './pages.ts';

type OutlineTree = { name: string; lang: string; entries: unknown[] };
type Server = {
  routes(trees: OutlineTree[]): string[];
  render(path: string, tree?: OutlineTree): string;
  renderNotFound(): string;
  head(path: string, trees: OutlineTree[], base: string): Head;
  outlineNames: string[];
};

const site = resolve(import.meta.dirname, '..');
const dist = join(site, 'dist');
const server = (await import(pathToFileURL(join(site, 'dist-ssr/entry-server.js')).href)) as Server;
const base = (process.env.VITE_PUBLIC_URL ?? '').replace(/\/+$/, '');

const template = checkTemplate(readFileSync(join(dist, 'index.html'), 'utf8'));
const page = (markup: string, head: Head, extra?: string[]) => fill(template, markup, head, base, extra);

function write(file: string, html: string) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
}

// first, while index.html is still the bare page: the lesson player's, which nothing indexes
write(join(dist, 'player.html'), playerPage(template));

const trees = server.outlineNames.map((name) => JSON.parse(readFileSync(join(dist, 'outlines', `${name}.json`), 'utf8')) as OutlineTree);
const routes = server.routes(trees);
for (const path of routes) {
  const outline = /^\/o\/([a-z0-9-]+)/.exec(path)?.[1];
  const markup = server.render(path, outline ? trees.find((t) => t.name === outline) : undefined);
  write(join(dist, path === '/' ? 'index.html' : `${path.slice(1)}/index.html`), page(markup, server.head(path, trees, base)));
}
// for any path: no canonical link of its own
const nothing = { title: 'Nothing here · thia', description: 'This page isn’t here.', lang: 'en', path: '/' };
write(join(dist, '404.html'), fill(template, server.renderNotFound(), nothing, '', ['<meta name="robots" content="noindex">']));

if (base) {
  const urls = routes.map((p) => `  <url><loc>${text(`${base}${p}`)}</loc></url>`).join('\n');
  write(join(dist, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
  write(join(dist, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n`);
}
console.log(`prerendered ${routes.length} pages${base ? `, sitemap for ${base}` : ' (no VITE_PUBLIC_URL: no canonical links or sitemap)'}`);
