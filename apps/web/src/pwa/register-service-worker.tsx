"use client";

import { useEffect } from "react";

/**
 * Registers the service worker that powers offline support. Rendered once from the
 * root layout; it renders nothing and degrades gracefully on browsers without
 * service worker support.
 */
export function RegisterServiceWorker() {
  useEffect(() => {
    if (!navigator.serviceWorker) return;
    // Registration is best-effort: a failure must never block the app from booting.
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }, []);

  return null;
}
