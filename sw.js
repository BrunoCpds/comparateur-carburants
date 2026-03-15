/* ============================================================
   Service Worker — Comparateur Prix Carburants (PWA)
   Cache les ressources statiques, network-first pour l'API
   ============================================================ */

const CACHE_NAME = 'carburant-v4';
const STATIC_ASSETS = [
  './',
  './index.html',
  './js/api.js',
  './js/map.js',
  './js/route.js',
  './js/utils.js',
  './js/favorites.js',
  './manifest.json',
  './favicon.svg',
];

// CDN a mettre en cache
const CDN_ASSETS = [
  'https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap',
  'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css',
  'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js',
  'https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css',
  'https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css',
  'https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js',
];

/* ---- Installation : mise en cache des ressources statiques ---- */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // Ajouter les assets locaux (ignorer les erreurs pour les CDN)
      return cache.addAll(STATIC_ASSETS).then(() => {
        return Promise.allSettled(CDN_ASSETS.map(url => cache.add(url)));
      });
    })
  );
  self.skipWaiting();
});

/* ---- Activation : nettoyage des anciens caches ---- */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

/* ---- Fetch : network-first pour l'API, cache-first pour le reste ---- */
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API data.economie.gouv.fr → network-first avec fallback cache
  if (url.hostname === 'data.economie.gouv.fr') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // API 2aaz (noms stations) → network-first avec fallback cache
  if (url.hostname.includes('2aaz.fr')) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // OSRM / Nominatim → network-only (pas de cache)
  if (url.hostname.includes('osrm') || url.hostname.includes('nominatim')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Tout le reste → cache-first avec fallback network
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Mettre en cache les reponses valides
        if (response.ok && (event.request.url.startsWith('http'))) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
