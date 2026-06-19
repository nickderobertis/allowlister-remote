import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The Vitest target runs with apps/web as its working directory.
const swSource = readFileSync(resolve(process.cwd(), "public/sw.js"), "utf8");

/** Minimal in-memory CacheStorage to exercise the worker without a browser. */
class FakeCache {
  store = new Map<string, Response>();
  async addAll(urls: string[]) {
    for (const url of urls) this.store.set(url, new Response(`cached:${url}`));
  }
  async put(request: RequestLike, response: Response) {
    this.store.set(urlOf(request), response);
  }
  async match(request: RequestLike) {
    return this.store.get(urlOf(request));
  }
}

type RequestLike = string | { url: string; method?: string; mode?: string };
const urlOf = (request: RequestLike) => (typeof request === "string" ? request : request.url);

function createScope(fetchImpl: (request: RequestLike) => Promise<Response>) {
  const caches = new Map<string, FakeCache>();
  const listeners: Record<string, (event: SwEvent) => void> = {};
  const cacheStorage = {
    async open(name: string) {
      const cache = caches.get(name) ?? new FakeCache();
      caches.set(name, cache);
      return cache;
    },
    async keys() {
      return [...caches.keys()];
    },
    async match(request: RequestLike) {
      for (const cache of caches.values()) {
        const hit = await cache.match(request);
        if (hit) return hit;
      }
      return undefined;
    },
    async delete(name: string) {
      return caches.delete(name);
    },
  };
  const self = {
    addEventListener(type: string, handler: (event: SwEvent) => void) {
      listeners[type] = handler;
    },
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn() },
    caches: cacheStorage,
  };
  const sandbox = {
    self,
    caches: cacheStorage,
    fetch: vi.fn(fetchImpl),
    Response,
    Request,
    console,
  };
  vm.runInNewContext(swSource, sandbox);
  return { listeners, caches, self, fetch: sandbox.fetch };
}

interface SwEvent {
  request: RequestLike | undefined;
  waitUntil: (p: Promise<unknown>) => void;
  respondWith: (p: Promise<Response>) => void;
}

async function dispatch(
  listeners: Record<string, (event: SwEvent) => void>,
  type: string,
  request?: RequestLike,
) {
  const pending: Promise<unknown>[] = [];
  let responded: Promise<Response> | undefined;
  listeners[type]?.({
    request,
    waitUntil: (p) => pending.push(p),
    respondWith: (p) => {
      responded = p;
    },
  });
  await Promise.all(pending);
  return responded ? await responded : undefined;
}

describe("service worker", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("precaches the app shell, including an offline fallback, on install", async () => {
    const { listeners, caches } = createScope(async () => new Response("net"));
    await dispatch(listeners, "install");

    const cache = [...caches.values()][0];
    expect(cache).toBeTruthy();
    const cached = [...(cache?.store.keys() ?? [])];
    expect(cached).toContain("/");
    expect(cached).toContain("/offline");
    expect(cached).toContain("/manifest.webmanifest");
  });

  it("drops stale caches on activate", async () => {
    const { listeners, caches } = createScope(async () => new Response("net"));
    caches.set("allowlister-remote-stale", new FakeCache());
    await dispatch(listeners, "install");
    await dispatch(listeners, "activate");
    expect([...caches.keys()]).not.toContain("allowlister-remote-stale");
  });

  it("serves the cached shell when a navigation request is offline", async () => {
    const offline = vi.fn(async (request: RequestLike) => {
      if (urlOf(request) === "/") return new Response("live home");
      throw new Error("offline");
    });
    const { listeners } = createScope(offline);
    await dispatch(listeners, "install");

    // First navigation succeeds and is cached.
    const live = await dispatch(listeners, "fetch", {
      url: "/",
      method: "GET",
      mode: "navigate",
    });
    expect(await live?.text()).toBe("live home");

    // Now the network is down; the worker must fall back to the cache.
    offline.mockRejectedValue(new Error("offline"));
    const cached = await dispatch(listeners, "fetch", {
      url: "/",
      method: "GET",
      mode: "navigate",
    });
    expect(await cached?.text()).toBe("live home");
  });

  it("falls back to the offline page for uncached navigations", async () => {
    const { listeners } = createScope(async () => {
      throw new Error("offline");
    });
    await dispatch(listeners, "install");

    const response = await dispatch(listeners, "fetch", {
      url: "/never-visited",
      method: "GET",
      mode: "navigate",
    });
    expect(await response?.text()).toBe("cached:/offline");
  });

  it("ignores non-GET requests", async () => {
    const { listeners } = createScope(async () => new Response("net"));
    const response = await dispatch(listeners, "fetch", {
      url: "/api/approval-requests",
      method: "POST",
      mode: "cors",
    });
    expect(response).toBeUndefined();
  });
});
