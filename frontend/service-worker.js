// Minimal service worker — exists only to satisfy "Add to Home Screen" installability
// criteria so the app can run standalone (no browser address bar). Everything here is
// live/dynamic (Socket.IO, translation API), so this deliberately does NOT cache anything;
// it's a pure passthrough.
self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
    // no-store: skip the browser's own HTTP cache too, not just this worker — otherwise
    // "passthrough" still isn't enough to guarantee a genuinely fresh load every time.
    event.respondWith(fetch(event.request, { cache: 'no-store' }));
});
