/**
 * Service Worker — caches the app shell (HTML/CSS/JS/icons) for offline
 * startup and install-as-app support. Departure data is never cached: it
 * always goes to the network, so the board never shows stale data as if
 * it were live.
 */
'use strict';

// Bump this whenever a shell file changes so clients pick up the new set
// instead of serving a stale mix of old and new files.
const CACHE_VERSION = 'v1';
const CACHE_NAME = `bvg-shell-${CACHE_VERSION}`;

const SHELL_FILES = [
    './',
    './index.html',
    './manifest.json',
    './css/styles.css',
    './js/api.js',
    './js/app.js',
    './js/led-renderer.js',
    './icons/icon-192.png',
    './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(SHELL_FILES))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((names) => Promise.all(
                names.filter((name) => name !== CACHE_NAME)
                     .map((name) => caches.delete(name))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);

    // Only ever handle same-origin app-shell requests. Departure/search API
    // calls go to v6.bvg.transport.rest / v6.vbb.transport.rest and must
    // always hit the network — caching them would let the board silently
    // show old departures as if they were current.
    if (url.origin !== self.location.origin) return;

    // Network-first for the HTML document itself, so a deployed update is
    // picked up on the next load instead of waiting for a cache eviction.
    // Falls back to the cached shell when offline.
    if (request.mode === 'navigate' || url.pathname.endsWith('/index.html')) {
        event.respondWith(
            fetch(request)
                .then((response) => {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
                    return response;
                })
                .catch(() => caches.match('./index.html'))
        );
        return;
    }

    // Cache-first for static assets (CSS/JS/icons) — they're versioned by
    // CACHE_VERSION, not by content, so a cache hit is always correct.
    event.respondWith(
        caches.match(request).then((cached) => cached || fetch(request))
    );
});
