const CACHE_NAME = 'trackr-shell-v3';
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/offline.html'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.map(k => { if (k !== CACHE_NAME) return caches.delete(k); })
    ))
  );
  self.clients.claim();
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    const copy = response.clone();
    caches.open(CACHE_NAME).then(c => c.put(request, copy));
    return response;
  } catch (err) {
    return caches.match('/offline.html');
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Handle navigations (page loads, address bar, etc.)
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then(resp => {
        const copy = resp.clone();
        caches.open(CACHE_NAME).then(c => c.put(request, copy));
        return resp;
      }).catch(async () => {
        // Try both "/" and "/index.html"
        const cachedRoot = await caches.match('/');
        const cachedIndex = await caches.match('/index.html');
        return cachedRoot || cachedIndex || caches.match('/offline.html');
      })
    );
    return;
  }

  // Cache-first for styles, scripts, images
  if (['style', 'script', 'image'].includes(request.destination)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Fallback to network or cache
  event.respondWith(
    fetch(request).catch(() => caches.match(request))
  );
});