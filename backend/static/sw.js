const CACHE_NAME = 'sorumatik-v1';
const ASSETS = [
    '/',
    '/static/style.css',
    '/static/app.js',
    '/static/icon-192.png',
    '/static/icon-512.png'
];

// Dosyaları önbelleğe al
self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(ASSETS);
        })
    );
    self.skipWaiting();
});

// Önbelleği temizle
self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.map((key) => {
                    if (key !== CACHE_NAME) {
                        return caches.delete(key);
                    }
                })
            );
        })
    );
});

// Ağ isteklerini yakala (Network First, fallback to Cache)
self.addEventListener('fetch', (e) => {
    // API isteklerini önbelleğe alma
    if (e.request.url.includes('/api/') || e.request.url.includes('/solve') || e.request.url.includes('/coach')) {
        return; 
    }
    e.respondWith(
        fetch(e.request).catch(() => caches.match(e.request))
    );
});