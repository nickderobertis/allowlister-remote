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

// --- Broker bridge -----------------------------------------------------------
// One WebSocket per browser (shared across all tabs) connects the PWA to the
// Rust broker. The page asks the worker to connect; the worker subscribes,
// relays every broker event to all clients via postMessage, and forwards
// decisions back. It reconnects with capped exponential backoff so a session
// open for hours or days survives transient drops.

let brokerSocket = null;
let brokerUrl = null;
let brokerBackoff = 1000;

function broadcastToClients(message) {
  self.clients.matchAll({ includeUncontrolled: true }).then((clients) => {
    for (const client of clients) client.postMessage(message);
  });
}

function connectBroker(url) {
  brokerUrl = url;
  // Reuse a live or still-connecting socket rather than stacking connections.
  if (brokerSocket && (brokerSocket.readyState === 0 || brokerSocket.readyState === 1)) return;
  if (typeof WebSocket === "undefined") return;

  const socket = new WebSocket(url);
  brokerSocket = socket;

  socket.addEventListener("open", () => {
    brokerBackoff = 1000;
    socket.send(JSON.stringify({ type: "subscribe" }));
    broadcastToClients({ type: "broker-status", status: "open" });
  });
  socket.addEventListener("message", (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return; // ignore non-JSON frames
    }
    broadcastToClients({ type: "broker-event", event: payload });
  });
  socket.addEventListener("close", () => {
    broadcastToClients({ type: "broker-status", status: "closed" });
    if (brokerUrl) {
      setTimeout(() => connectBroker(brokerUrl), brokerBackoff);
      brokerBackoff = Math.min(brokerBackoff * 2, 30000);
    }
  });
  socket.addEventListener("error", () => {
    try {
      socket.close();
    } catch {
      // closing a socket that never opened can throw; ignore.
    }
  });
}

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "broker-connect" && typeof data.url === "string") {
    connectBroker(data.url);
  } else if (data.type === "decision" && brokerSocket && brokerSocket.readyState === 1) {
    brokerSocket.send(
      JSON.stringify({
        type: "decision",
        requestId: data.requestId,
        verdict: data.verdict,
        reason: data.reason,
      }),
    );
  }
});
