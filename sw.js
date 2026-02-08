
const CACHE_NAME = 'salin-v3';
const STATIC_ASSETS = [
  './',
  './index.html',
  './metadata.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
});

self.addEventListener('fetch', (event) => {
  // Use a Network-First strategy for application logic to ensure updates aren't blocked by SW cache
  event.respondWith(
    fetch(event.request).catch(() => {
      return caches.match(event.request);
    })
  );
});
