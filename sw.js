/* sw.js — offline support.
   App shell is precached; Scryfall card images are cached as they are seen. */

var VERSION = 'v1.0.0';
var SHELL = 'tt-shell-' + VERSION;
var IMAGES = 'tt-images-v1';

var SHELL_FILES = [
  './',
  './index.html',
  './css/app.css',
  './js/data.js',
  './js/parse.js',
  './js/scryfall.js',
  './js/bridge.js',
  './js/mana.js',
  './js/triggers.js',
  './js/store.js',
  './js/sample.js',
  './js/app.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', function (ev) {
  ev.waitUntil(
    caches.open(SHELL).then(function (cache) {
      // Individual failures must not abort the whole install.
      return Promise.all(SHELL_FILES.map(function (url) {
        return cache.add(url).catch(function () { return null; });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (ev) {
  ev.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== SHELL && k !== IMAGES) { return caches.delete(k); }
        return null;
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (ev) {
  var req = ev.request;
  if (req.method !== 'GET') { return; }

  var url = new URL(req.url);

  // Card art: cache-first, it never changes.
  if (/scryfall\.io|scryfall\.com\/.*\.(png|jpg|jpeg)/.test(url.href)) {
    ev.respondWith(
      caches.open(IMAGES).then(function (cache) {
        return cache.match(req).then(function (hit) {
          if (hit) { return hit; }
          return fetch(req).then(function (res) {
            if (res.ok) { cache.put(req, res.clone()); }
            return res;
          });
        });
      })
    );
    return;
  }

  // Never cache the card API — scryfall.js keeps its own localStorage cache.
  if (url.hostname === 'api.scryfall.com') { return; }

  // App shell: network-first so updates land, falling back to cache offline.
  if (url.origin === location.origin) {
    ev.respondWith(
      fetch(req).then(function (res) {
        if (res.ok) {
          var copy = res.clone();
          caches.open(SHELL).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        return caches.match(req).then(function (hit) {
          return hit || caches.match('./index.html');
        });
      })
    );
  }
});
