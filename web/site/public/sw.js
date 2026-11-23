// The origin's one service worker, for both apps on it: the use app (this site, prerendered: a page per path) and the
// make app (its one page under /make/, for /workshop, /review and /runs). Opens them offline: the user's data is in
// this browser, only the pages come from the web. A page comes from the network when it can, so a new version shows
// on the next load, else from the cache: the one for its path, else the site's start page (it finds its way from
// there). The hashed build files never change, so they come from the cache once fetched. Only this origin's own files
// are kept, and never the server's answers (/api) or a lesson's (/l/, /lessons/, on the lesson domain anyway).
const CACHE = 'thia-v1';
const SITE = '/';
const MAKE = '/make/index.html';
const isMake = (path) => /^\/(workshop|review|runs)(\/|$)/.test(path);

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const keep = (key, response) => {
  if (response.ok) { const copy = response.clone(); void caches.open(CACHE).then((c) => c.put(key, copy)); }
  return response;
};
const cached = (...keys) => keys.reduce((p, k) => p.then((hit) => hit ?? caches.match(k)), Promise.resolve(undefined));

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || /^\/(api|l|lessons)\//.test(url.pathname)) return;
  if (request.mode === 'navigate') {
    // a page by its path (without the hash or query a view keeps its place in); the make app's areas are one page
    const key = isMake(url.pathname) ? MAKE : url.pathname;
    const fallback = isMake(url.pathname) ? MAKE : SITE;
    event.respondWith(fetch(request).then((r) => keep(key, r)).catch(() => cached(key, fallback).then((hit) => hit ?? Response.error())));
    return;
  }
  if (!/^\/(make\/)?assets\//.test(url.pathname)) {
    event.respondWith(fetch(request).then((r) => keep(request, r)).catch(() => caches.match(request).then((hit) => hit ?? Response.error())));
    return;
  }
  event.respondWith(caches.match(request).then((hit) => hit ?? fetch(request).then((r) => keep(request, r))));
});
