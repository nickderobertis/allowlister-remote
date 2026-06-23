// Client-side broker URL resolution and persistence.
//
// The PWA is a fully static bundle with no server of its own, so the broker URL
// is a setting the browser holds rather than something a server route hands
// back. Resolution precedence on load:
//   1. a `?broker=<url>` query parameter — a one-time deep link, also persisted
//      so reloads (and the service worker) keep using it;
//   2. the saved setting in localStorage;
//   3. an optional build-time default baked in via
//      `NEXT_PUBLIC_ALLOWLISTER_REMOTE_BROKER_URL`.
// The stored value is the broker *base* (e.g. `wss://broker.example.com`); the
// service-worker WebSocket endpoint is derived as `<base>/ws/pwa`, matching the
// `/ws/pwa` path the broker serves.

export const BROKER_URL_STORAGE_KEY = "allowlister-remote-broker-url";
const QUERY_PARAM = "broker";

function buildTimeDefault(): string | null {
  const fromEnv = process.env.NEXT_PUBLIC_ALLOWLISTER_REMOTE_BROKER_URL;
  return fromEnv && fromEnv.length > 0 ? fromEnv : null;
}

function readStored(): string | null {
  try {
    const value = window.localStorage.getItem(BROKER_URL_STORAGE_KEY);
    return value && value.length > 0 ? value : null;
  } catch {
    // localStorage can throw (private mode, disabled storage); treat as unset.
    return null;
  }
}

/** Persist the user's broker base URL, or clear it when given an empty value. */
export function setStoredBrokerBase(base: string | null): void {
  const trimmed = base?.trim() ?? "";
  try {
    if (trimmed) {
      window.localStorage.setItem(BROKER_URL_STORAGE_KEY, trimmed);
    } else {
      window.localStorage.removeItem(BROKER_URL_STORAGE_KEY);
    }
  } catch {
    // Non-fatal: the in-memory setting still drives this session.
  }
}

/**
 * Resolve the broker base URL the app should connect to. A `?broker=` deep link
 * wins and is persisted; otherwise the saved setting, then the build-time
 * default. Returns null when nothing is configured (the app then shows its
 * broker-setup screen). Browser-only — call from an effect, not during render.
 */
export function resolveBrokerBase(
  search: string = typeof window === "undefined" ? "" : window.location.search,
): string | null {
  const fromQuery = new URLSearchParams(search).get(QUERY_PARAM)?.trim();
  if (fromQuery) {
    setStoredBrokerBase(fromQuery);
    return fromQuery;
  }
  return readStored() ?? buildTimeDefault();
}

/** Derive the service-worker WebSocket endpoint from a broker base URL. */
export function brokerWsUrl(base: string): string {
  return `${base.replace(/\/+$/, "")}/ws/pwa`;
}
