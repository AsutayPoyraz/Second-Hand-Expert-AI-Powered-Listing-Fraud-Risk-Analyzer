'use strict';

/**
 * Minimal service worker: yalnızca uygulama kabuğunu (HTML/CSS/JS) önbelleğe alır.
 * API yanıtları ASLA önbelleğe alınmaz (analiz sonuçları kişiye özeldir).
 */

const CACHE = 'ieks-shell-v2.6.0';
const SHELL = ['/', '/index.html', '/css/style.css', '/js/app.js', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // Ağ öncelikli: güncel dosya varsa onu kullan, çevrimdışıysa önbellekten sun.
  event.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok && (url.pathname === '/' || /\.(html|css|js|webmanifest)$/.test(url.pathname))) {
          const copy = res.clone();
          caches.open(CACHE).then(cache => cache.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then(cached => cached || caches.match('/index.html')))
  );
});
