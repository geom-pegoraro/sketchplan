/**
 * PlanSketcher – sw.js
 * Service Worker per funzionamento offline
 */

const CACHE_NAME = 'plansketcher-v2.0';
const STATIC_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './import-pdf.js',
  './manifest.json',
  'https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Syne:wght@400;600;700;800&display=swap',
];

// ---- INSTALL: metti in cache le risorse statiche ----
self.addEventListener('install', (event) => {
  console.log('[SW] Install');
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS.map(url => {
        // Non fallire se alcune risorse non sono raggiungibili offline
        return cache.add(url).catch(() => {});
      }));
    }).then(() => self.skipWaiting())
  );
});

// ---- ACTIVATE: elimina vecchie cache ----
self.addEventListener('activate', (event) => {
  console.log('[SW] Activate');
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// ---- FETCH: strategia Cache First per risorse statiche ----
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Ignora richieste non GET
  if (request.method !== 'GET') return;

  // Ignora richieste a domini esterni non in cache (es. jsPDF CDN)
  const url = new URL(request.url);

  // Per risorse della stessa origine: Cache First
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        }).catch(() => {
          // Fallback per navigazione offline
          if (request.destination === 'document') {
            return caches.match('./index.html');
          }
        });
      })
    );
    return;
  }

  // Per risorse esterne (Google Fonts, CDN): Network First con cache fallback
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});
