// Offline cache for the Chooser app.
// Strategy: stale-while-revalidate — answer instantly from the cache (works with
// no signal) and refresh the cached copy in the background, so a new version is
// picked up on the next launch. Bump VERSION to force a clean re-cache.
const VERSION = 'chooser-v2';
const FILES = [
  './',
  './index.html',
  './app.js',
  './manifest.webmanifest',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const key = req.mode === 'navigate' ? './index.html' : req;

  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const cached = await cache.match(key, { ignoreSearch: true });
    const refresh = fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res && res.ok && res.type === 'basic') cache.put(key, res.clone()).catch(() => {});
        return res;
      })
      .catch(() => null);
    if (cached) {
      event.waitUntil(refresh);
      return cached;
    }
    const res = await refresh;
    return res || (req.mode === 'navigate' ? (await cache.match('./index.html')) || Response.error() : Response.error());
  })());
});
