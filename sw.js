// Section.

const CACHE_NAME = 'kairos-v17';

// Only genuinely static, rarely-changing assets are safe to cache-first. The redesign's CSS (design-to...
const STATIC_ASSETS = [
  '/manifest.json',
  '/icons.svg',
  '/icon-192.png',
  '/icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js'
];

// Install — cache only static assets
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_ASSETS).catch(err => {
        console.warn('Cache install error (non-fatal):', err);
      });
    })
  );
  self.skipWaiting();
});

// Activate — clean out every old cache version
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch strategy: - Never intercept non-GET requests (POST/PATCH/DELETE always hit the network) - Neve...
const NEVER_CACHE_PATTERNS = [
  '/api/', '/ask', '/vision', '/screen', '/memory',
  '/upload_pdf', '/health', '/login', '/app', '/auth.htm',
  '/onboarding.htm', '/settings.htm', '/admin', '/Admn.html'
];

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;

  if (e.request.method !== 'GET') return;
  if (NEVER_CACHE_PATTERNS.some(p => url.pathname.startsWith(p))) return;

  const isStaticAsset = STATIC_ASSETS.some(asset =>
    e.request.url === asset || url.pathname === asset
  );

  if (isStaticAsset) {
    // Cache-first for static assets
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request))
    );
  } else {
    // Network-first for everything else (HTML/JS/CSS app files), so code changes are picked up immediately during development.
    e.respondWith(
      fetch(e.request)
        .then(response => {
          if (response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME)
              .then(cache => cache.put(e.request, clone))
              .catch(() => { /* cache writes are best-effort */ });
          }
          return response;
        })
        .catch(() => caches.match(e.request).then(cached => cached || new Response(
          'Offline',
          { status: 503, statusText: 'Service Unavailable',
            headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
        )))
    );
  }
});
