// Service Worker — Xbox Deals (v13)
// Red primero para catálogo de datos (IndexedDB se encarga de la velocidad local)
const CACHE = 'xbox-deals-v13';
const STATIC = ['./manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)).catch(() => {}));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Navegación / Documento HTML -> Network-first con fallback inmediato a cache
  if (e.request.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('/')) {
    e.respondWith(
      fetch(e.request)
        .then(r => {
          if (r.ok) {
            const clone = r.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone)).catch(() => {});
          }
          return r;
        })
        .catch(() => caches.match(e.request).then(cached => cached || caches.match('./index.html')))
    );
    return;
  }

  // history.json -> Bypass cache de Service Worker para preservar cuota en iPhone WebKit
  if (url.pathname.endsWith('/history.json')) {
    return;
  }

  // data/*.json (meta.json, games.json, addons.json) -> Red primero
  // Garantiza recibir siempre las últimas ofertas y juegos sin ser bloqueado por caché antigua.
  if (url.pathname.includes('/data/')) {
    e.respondWith(
      fetch(e.request)
        .then(r => {
          if (r.ok) {
            const clone = r.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone)).catch(() => {});
          }
          return r;
        })
        .catch(() => caches.match(e.request).then(cached => cached || new Response('[]', { headers: { 'content-type': 'application/json' } })))
    );
    return;
  }

  // Externos (imágenes Microsoft Store, Flags, Fonts) -> Network directo
  if (!url.origin.includes(self.location.origin)) return;

  // Assets estáticos propios -> Cache-first
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(r => {
        if (r.ok) {
          const clone = r.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone)).catch(() => {});
        }
        return r;
      });
    })
  );
});
