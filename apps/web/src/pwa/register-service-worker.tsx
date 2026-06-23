"use client";

import { useEffect } from "react";

// Best-effort: ask once for notification permission so the worker can raise an
// OS notification (with Approve/Deny actions) when an approval arrives. A browser
// that requires a user gesture rejects this; we swallow it rather than block
// boot, and never re-ask once the user has answered (permission !== "default").
function requestNotificationPermission() {
  if (typeof Notification === "undefined" || Notification.permission !== "default") return;
  try {
    Promise.resolve(Notification.requestPermission()).catch(() => {});
  } catch {
    // Older browsers can throw synchronously; ignore.
  }
}

/**
 * Registers the service worker that powers offline support and approval
 * notifications. Rendered once from the root layout; it renders nothing and
 * degrades gracefully on browsers without service worker support.
 */
export function RegisterServiceWorker() {
  useEffect(() => {
    if (!navigator.serviceWorker) return;
    // Registration is best-effort: a failure must never block the app from booting.
    navigator.serviceWorker.register("/sw.js").catch(() => {});
    requestNotificationPermission();
  }, []);

  return null;
}
