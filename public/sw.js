// Service Worker — Xbox Deals (v2)
// Estrategia: network-first para HTML y datos, cache-first para assets estáticos
const CACHE = 'xbox-deals-v2';
const STATIC = ['./manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)));
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

  // Navegación / Documento HTML -> Network-first (para que siempre se cargue la versión actualizada)
  if (e.request.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('/')) {
    e.respondWith(
      fetch(e.request)
        .then(r => {
          if (r.ok) { const clone = r.clone(); caches.open(CACHE).then(c => c.put(e.request, clone)); }
          return r;
        })
        .catch(() => caches.match(e.request).then(cached => cached || caches.match('./index.html')))
    );
    return;
  }

  // Datos JSON -> Network-first (para tener precios siempre actualizados)
  if (url.pathname.includes('/data/')) {
    e.respondWith(
      fetch(e.request)
        .then(r => {
          if (r.ok) { const clone = r.clone(); caches.open(CACHE).then(c => c.put(e.request, clone)); }
          return r;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Externos (imágenes Microsoft Store, Flags, Fonts) -> Network directo
  if (!url.origin.includes(self.location.origin)) return;

  // Assets estáticos propios (iconos, manifest) -> Cache-first
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(r => {
        if (r.ok) { const clone = r.clone(); caches.open(CACHE).then(c => c.put(e.request, clone)); }
        return r;
      });
    })
  );
});
