// sw.js — Service Worker: cache-first strategy for Time Traveler
// Version: 1.4.20260330
// Bump CACHE_NAME whenever app files change to evict stale assets.

const CACHE_NAME = 'time-traveler-v1.4.20260330';

const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './zones.js',
  './scroller.js',
  './time-utils.js',
  './manifest.json',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
];

// ── Install: pre-cache all app shell files ────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL))
  );
  // Activate immediately without waiting for existing tabs to close
  self.skipWaiting();
});

// ── Activate: delete caches from older versions ───────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    )
  );
  // Take control of all open clients immediately
  self.clients.claim();
});

// ── Fetch: cache-first, fall back to network ──────────────────────────────────
self.addEventListener('fetch', (event) => {
  // Only handle GET requests for same-origin or CDN assets
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;

      // Not in cache — fetch from network and cache for next time
      return fetch(event.request).then(response => {
        // Only cache valid responses
        if (!response || response.status !== 200 || response.type === 'error') {
          return response;
        }
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      });
    })
  );
});
