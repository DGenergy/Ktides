// App shell cache-first; API network-first with cached fallback (works offline with last data).
const V = 'tides-v5';
const API = /open-meteo\.com|tidesandcurrents\.noaa\.gov|bigdatacloud\.net/;
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'map.js', 'wind.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V && k !== 'tides-api').map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (u.origin === location.origin) {
    // network-first for the shell too, so pushes to GitHub show up on next open
    e.respondWith(fetch(e.request).then((r) => { const cp = r.clone(); caches.open(V).then((c) => c.put(e.request, cp)); return r; })
      .catch(() => caches.match(e.request, { ignoreSearch: true })));
    return;
  }
  if (!API.test(u.hostname)) return; // map tiles, CDN: browser cache only
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) { const cp = r.clone(); caches.open('tides-api').then((c) => c.put(e.request, cp)); }
    return r;
  }).catch(() => caches.open('tides-api').then((c) => c.match(e.request))));
});
