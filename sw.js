// Capsule offline cache. Lets the app open instantly and show your archive on a bad or blocked
// connection, and keeps the cutout model so background removal works without reaching its server.
const VERSION = '202611271136'; // stamped on every release
const SHELL = `capsule-shell-${VERSION}`;
const PHOTOS = 'capsule-photos-v1';
const MODEL = 'capsule-model-v1';
const DATA = 'capsule-data-v1';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(['./', './index.html', './manifest.webmanifest', './icon-192.png'])).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('capsule-shell-') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

// Signed photo URLs carry a token that changes; cache by the file path so any token finds the copy.
const photoKey = url => new Request(url.origin + url.pathname.replace('/object/sign/', '/object/'));

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // The page itself: try the network first so updates arrive, fall back to the cached copy.
  if (req.mode === 'navigate') { e.respondWith(networkFirst(req, SHELL, 4000, './index.html')); return; }

  // App files, fonts and bundled libraries: versioned, so the cached copy is always right.
  if (url.origin === self.location.origin) { e.respondWith(cacheFirst(req, SHELL)); return; }

  // Garment photos from Supabase Storage.
  if (url.pathname.includes('/storage/v1/object/')) { e.respondWith(cacheFirst(req, PHOTOS, photoKey(url))); return; }

  // Background-removal model and its runtime: large, versioned files.
  if (url.hostname === 'staticimgly.com') { e.respondWith(cacheFirst(req, MODEL)); return; }

  // Weather: fresh when possible, last result when not.
  if (url.hostname === 'api.open-meteo.com') { e.respondWith(networkFirst(req, DATA, 6000)); return; }
  // Everything else (database and sign-in) goes straight to the network; the app keeps its own snapshot.
});

async function cacheFirst(req, cacheName, key = req) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(key, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(key, res.clone()).catch(() => {});
  return res;
}

async function networkFirst(req, cacheName, timeoutMs, fallbackUrl) {
  const cache = await caches.open(cacheName);
  try {
    const res = await Promise.race([fetch(req), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))]);
    if (res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: req.mode === 'navigate' }) || (fallbackUrl && await cache.match(fallbackUrl));
    if (hit) return hit;
    throw err;
  }
}
