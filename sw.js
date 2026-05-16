// ════════════════════════════════════════
//  sw.js  —  KAIROS SERVICE WORKER
//  Enables offline support and fast loading
// ════════════════════════════════════════

const CACHE_NAME = 'kairos-v12';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/style.css',
  '/script.js',
  '/brain.js',
  '/manifest.json',
  'https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Share+Tech+Mono&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js'
];

// Install — cache all assets
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(ASSETS_TO_CACHE).catch(err => {
        console.warn('Cache install error (non-fatal):', err);
      });
    })
  );
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch — serve from cache, fallback to network
self.addEventListener('fetch', (e) => {
  // Don't intercept API calls — always fetch live
  if (e.request.url.includes('localhost:5000') ||
    e.request.url.includes('openrouter.ai') ||
    e.request.method !== 'GET') {
    return;
  }

  e.respondWith(
    caches.match(e.request).then(cached => {
      return cached || fetch(e.request).then(response => {
        // Cache new requests
        if (response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return response;
      }).catch(() => {
        // Offline fallback
        return caches.match('/index.html');
      });
    })
  );
});