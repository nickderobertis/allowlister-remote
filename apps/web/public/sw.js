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

  // Stale-while-revalidate for static assets: serve the cached copy immediately
  // when there is one, but refresh it in the background so an updated shell asset
  // (the precached, non-content-hashed files like the manifest or icons) replaces
  // itself on the next load — no manual cache-version bump required. When nothing
  // is cached yet, fall through to the network.
  event.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(request).then((cached) => {
        const networked = fetch(request)
          .then((response) => {
            if (response.ok) cache.put(request, response.clone());
            return response;
          })
          .catch(() => cached);
        return cached ?? networked;
      }),
    ),
  );
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
    // Surface a freshly announced request as an OS notification (with
    // Approve/Deny actions) so it reaches the operator even when the PWA is
    // backgrounded, and dismiss it again when the request is resolved — decided
    // here, in another tab, or at the local terminal.
    if (payload && payload.type === "added") {
      showRequestNotification(payload.request);
    } else if (payload && payload.type === "resolved" && typeof payload.requestId === "string") {
      closeRequestNotification(payload.requestId);
    }
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

// Route a decision back to the broker (and on to the waiting plugin). Returns
// false when the socket is not open so callers can fall back — a notification
// action, for instance, focuses the app instead of silently dropping the click.
function sendDecision(requestId, verdict, reason) {
  if (brokerSocket?.readyState !== 1) return false;
  brokerSocket.send(JSON.stringify({ type: "decision", requestId, verdict, reason }));
  return true;
}

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "broker-connect" && typeof data.url === "string") {
    connectBroker(data.url);
  } else if (data.type === "decision") {
    sendDecision(data.requestId, data.verdict, data.reason);
  }
});

// --- Approval notifications --------------------------------------------------
// When the broker announces a new request the worker raises an OS notification
// so a backgrounded device still hears about it. The body previews up to four of
// the lines the operator must weigh — the flagged shell fragments (allowlister
// already cleared the rest) or a tool call's verbatim arguments — and the two
// action buttons decide the request straight from the notification.

const NOTIFICATION_ICON = "/icon-192.png";
const NOTIFICATION_FRAGMENT_LIMIT = 4;

// The lines a notification previews: a shell request's flagged fragments (or all
// of them if — unexpectedly — none is flagged), mirroring the inbox's own
// `flaggedFragments`; a tool request's verbatim arguments, mirroring
// `toolCallLines`. The caller trims this to the four-line cap.
function notificationLines(request) {
  if (request.subject === "tool") {
    const raw = request.tool?.raw || {};
    return Object.entries(raw).map(
      ([key, value]) => `${key} = ${typeof value === "string" ? value : JSON.stringify(value)}`,
    );
  }
  const fragments = Array.isArray(request.fragments) ? request.fragments : [];
  const flagged = fragments.filter((fragment) => fragment && fragment.verdict !== "allow");
  const chosen = flagged.length > 0 ? flagged : fragments;
  return chosen
    .map((fragment) => fragment?.display)
    .filter((display) => typeof display === "string");
}

function notificationTitle(request) {
  const harness = request.harness || "allowlister";
  if (request.subject === "tool" && request.tool && request.tool.name) {
    return `${request.tool.name} · ${harness}`;
  }
  return `Shell approval · ${harness}`;
}

// Build the title/options for a request's notification: the previewed lines
// capped at four with a "+N more" tail, an Approve/Deny action pair, and a tag of
// the request id so a re-announce replaces (rather than stacks) the notification
// and a `resolved` event can find and clear it.
function notificationContent(request) {
  const lines = notificationLines(request);
  const shown = lines.slice(0, NOTIFICATION_FRAGMENT_LIMIT);
  const overflow = lines.length - shown.length;
  if (overflow > 0) shown.push(`+${overflow} more`);
  return {
    title: notificationTitle(request),
    options: {
      body: shown.join("\n"),
      tag: request.id,
      icon: NOTIFICATION_ICON,
      badge: NOTIFICATION_ICON,
      // An approval should persist until the operator (or another surface) acts.
      requireInteraction: true,
      data: { requestId: request.id },
      actions: [
        { action: "allow", title: "Approve" },
        { action: "deny", title: "Deny" },
      ],
    },
  };
}

function showRequestNotification(request) {
  if (!request || typeof request !== "object" || typeof request.id !== "string") return;
  const registration = self.registration;
  if (!registration || typeof registration.showNotification !== "function") return;
  // Don't double-surface a request a focused window already shows; only notify
  // when no PWA window is in the foreground.
  self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    if (clients.some((client) => client.focused || client.visibilityState === "visible")) return;
    const { title, options } = notificationContent(request);
    // showNotification rejects when permission was never granted; swallow it so a
    // denied permission never breaks the broker-event relay.
    registration.showNotification(title, options).catch(() => {});
  });
}

function closeRequestNotification(requestId) {
  const registration = self.registration;
  if (!registration || typeof registration.getNotifications !== "function") return;
  registration
    .getNotifications({ tag: requestId })
    .then((notifications) => {
      for (const notification of notifications) notification.close();
    })
    .catch(() => {});
}

function focusClient() {
  return self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    for (const client of clients) {
      if (typeof client.focus === "function") return client.focus();
    }
    return self.clients.openWindow ? self.clients.openWindow("/") : undefined;
  });
}

self.addEventListener("notificationclick", (event) => {
  const notification = event.notification;
  notification.close();
  const data = notification.data || {};
  const requestId = data.requestId;

  if ((event.action === "allow" || event.action === "deny") && typeof requestId === "string") {
    // Decide straight from the notification, routed back through the broker just
    // like an in-app decision. If the socket is down the decision can't be sent,
    // so fall through to focusing the app and let the operator decide there.
    if (sendDecision(requestId, event.action, `${event.action}ed from notification`)) return;
  }

  // A tap on the body (or an action that couldn't be sent) brings the PWA
  // forward — focusing an open window or opening one if none is visible.
  event.waitUntil(focusClient());
});
