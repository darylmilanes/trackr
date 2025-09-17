const CACHE_NAME = 'trackr-shell-v2';
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
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
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

// Utility: serve from cache, fallback to network
async function cacheFirst(request){
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  const copy = response.clone();
  caches.open(CACHE_NAME).then(c => c.put(request, copy));
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  // Navigation requests: try network first, fallback to cache/offline page
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then(resp => {
        // Update cache for navigation
        const copy = resp.clone();
        caches.open(CACHE_NAME).then(c => c.put(request, copy));
        return resp;
      }).catch(async () => {
        // If offline, serve cached index.html or offline.html
        const cachedIndex = await caches.match('/index.html');
        return cachedIndex || caches.match('/offline.html');
      })
    );
    return;
  }

  // For other requests, use cache-first for static assets (CSS/JS/PNG)
  if (request.destination === 'style' || request.destination === 'script' || request.destination === 'image'){
    event.respondWith(cacheFirst(request));
    return;
  }

  // Fallback to network for anything else
  event.respondWith(fetch(request).catch(()=>caches.match(request)));
});