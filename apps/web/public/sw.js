/// <reference lib="webworker" />
// Hand-rolled service worker: precache the app shell so allowlister-remote stays
// installable and usable when an agent request arrives while the device is offline.

const CACHE = "allowlister-remote-v1";
const APP_SHELL = ["/", "/offline", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  if (request.mode === "navigate") {
    // Network-first for navigations: keep the cached shell fresh, but fall back to
    // it (or the offline page) when the network is unavailable.
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached ?? caches.match("/offline"))),
    );
    return;
  }

  // Cache-first for static assets that were precached or seen before.
  event.respondWith(caches.match(request).then((cached) => cached ?? fetch(request)));
});
