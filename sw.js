// Airside service worker: lets the site open without signal and shows alert
// notifications (Android only shows page notifications through a worker).
// Site files are fetched fresh when online and served from this cache when not.
// Flight data isn't cached here; the page keeps its own last copy.
const CACHE = 'airside-v1';
const SHELL = [
  './', 'css/app.css',
  'js/app.js', 'js/flight.js', 'js/watch.js', 'js/fr24.js', 'js/format.js', 'js/icons.js', 'js/adsb.js', 'js/map.js',
  'fonts/atkinson-hyperlegible-next.woff2', 'fonts/barlow-semi-condensed-600.woff2', 'fonts/barlow-semi-condensed-700.woff2',
  'data/land.json', 'favicon.svg', 'manifest.webmanifest', 'icons/icon-192.png',
];
const TIMEOUT = 4000; // airport wifi can hang; fall back to the cache instead of waiting

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const isPage = req.mode === 'navigate';
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = () => cache.match(isPage ? './' : req, { ignoreSearch: isPage });
    try {
      const res = await Promise.race([
        fetch(req),
        new Promise((_, reject) => setTimeout(() => reject(new Error('slow network')), TIMEOUT)),
      ]);
      if (res.ok) cache.put(isPage ? './' : req, res.clone());
      return res;
    } catch (err) {
      const hit = await cached();
      if (hit) return hit;
      throw err;
    }
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url ?? self.registration.scope;
  e.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const tab = open.find(c => c.url.startsWith(self.registration.scope));
    if (tab) { await tab.focus(); return tab.navigate(url); }
    return self.clients.openWindow(url);
  })());
});
