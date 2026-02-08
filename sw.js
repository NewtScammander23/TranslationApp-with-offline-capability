
const CACHE_NAME = 'salin-v2';
const ASSETS = [
  './',
  './index.html',
  './index.tsx',
  './App.tsx',
  './metadata.json',
  './types.ts'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    })
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    })
  );
});
