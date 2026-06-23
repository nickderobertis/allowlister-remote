import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { brokerRequestPayloads } from "../test/broker-fixtures";

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

/** Minimal WebSocket double for the broker bridge: records sent frames and lets
 * a test drive open/message/close. */
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  private handlers: Record<string, ((event: { data?: string }) => void)[]> = {};
  constructor(public url: string) {}
  addEventListener(type: string, handler: (event: { data?: string }) => void) {
    const list = this.handlers[type] ?? [];
    list.push(handler);
    this.handlers[type] = list;
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.emit("close", {});
  }
  emit(type: string, event: { data?: string }) {
    for (const handler of this.handlers[type] ?? []) handler(event);
  }
  open() {
    this.readyState = 1;
    this.emit("open", {});
  }
}

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
  // Records every notification the worker raises so tests can assert title/body,
  // actions, and that a `resolved` event closes the matching one.
  type NotificationOptions = {
    tag?: string;
    body?: string;
    data?: { requestId?: string };
    actions?: unknown;
  };
  const shownNotifications: {
    title: string;
    options: NotificationOptions;
    tag: string | undefined;
    close: ReturnType<typeof vi.fn>;
  }[] = [];
  const registration = {
    showNotification: vi.fn((title: string, options: NotificationOptions) => {
      shownNotifications.push({ title, options, tag: options?.tag, close: vi.fn() });
      return Promise.resolve();
    }),
    getNotifications: vi.fn(({ tag }: { tag?: string } = {}) =>
      Promise.resolve(shownNotifications.filter((n) => tag === undefined || n.tag === tag)),
    ),
  };
  const self = {
    addEventListener(type: string, handler: (event: SwEvent) => void) {
      listeners[type] = handler;
    },
    skipWaiting: vi.fn(),
    clients: {
      claim: vi.fn(),
      // The broker bridge broadcasts to every client via matchAll().
      matchAll: async () => clientList,
      openWindow: vi.fn(async () => ({})),
    },
    registration,
    caches: cacheStorage,
  };
  const clientMessages: unknown[] = [];
  // Clients default to backgrounded so a notification is raised; a test can flip
  // `focused`/`visibilityState` or empty the list to drive the other branches.
  const clientList: {
    postMessage: (message: unknown) => void;
    focus: ReturnType<typeof vi.fn>;
    focused: boolean;
    visibilityState: string;
  }[] = [
    {
      postMessage: (message: unknown) => clientMessages.push(message),
      focus: vi.fn(async () => ({})),
      focused: false,
      visibilityState: "hidden",
    },
  ];
  const sockets: FakeWebSocket[] = [];
  class ScopedWebSocket extends FakeWebSocket {
    constructor(url: string) {
      super(url);
      sockets.push(this);
    }
  }
  const sandbox = {
    self,
    caches: cacheStorage,
    fetch: vi.fn(fetchImpl),
    Response,
    Request,
    console,
    WebSocket: ScopedWebSocket,
    // Reconnect timer is a no-op in tests so a dropped socket does not loop.
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
  vm.runInNewContext(swSource, sandbox);
  return {
    listeners,
    caches,
    self,
    fetch: sandbox.fetch,
    sockets,
    clientMessages,
    shownNotifications,
    registration,
    clientList,
  };
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
      url: "/decision",
      method: "POST",
      mode: "cors",
    });
    expect(response).toBeUndefined();
  });
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const message = (listeners: Record<string, (event: SwEvent) => void>, data: unknown) =>
  (listeners.message as unknown as (event: { data: unknown }) => void)?.({ data });
function only<T>(items: T[]): T {
  const [item] = items;
  if (!item) throw new Error("expected exactly one item");
  return item;
}

describe("service worker broker bridge", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("connects, subscribes, and relays broker events to all clients", async () => {
    const { listeners, sockets, clientMessages } = createScope(async () => new Response("net"));
    message(listeners, { type: "broker-connect", url: "ws://broker/ws/pwa" });
    expect(sockets).toHaveLength(1);
    const socket = only(sockets);
    expect(socket.url).toBe("ws://broker/ws/pwa");

    socket.open();
    expect(socket.sent).toContain(JSON.stringify({ type: "subscribe" }));

    socket.emit("message", { data: JSON.stringify({ type: "added", request: { id: "r1" } }) });
    await flush();
    expect(clientMessages).toContainEqual({
      type: "broker-event",
      event: { type: "added", request: { id: "r1" } },
    });
  });

  it("forwards a client decision to the broker once connected", () => {
    const { listeners, sockets } = createScope(async () => new Response("net"));
    message(listeners, { type: "broker-connect", url: "ws://b" });
    const socket = only(sockets);
    socket.open();
    message(listeners, { type: "decision", requestId: "r1", verdict: "allow", reason: "ok" });
    expect(socket.sent).toContain(
      JSON.stringify({ type: "decision", requestId: "r1", verdict: "allow", reason: "ok" }),
    );
  });

  it("reuses one socket instead of stacking connections", () => {
    const { listeners, sockets } = createScope(async () => new Response("net"));
    message(listeners, { type: "broker-connect", url: "ws://b" });
    only(sockets).open();
    message(listeners, { type: "broker-connect", url: "ws://b" });
    expect(sockets).toHaveLength(1);
  });

  it("ignores malformed broker frames and unknown client messages", async () => {
    const { listeners, sockets, clientMessages } = createScope(async () => new Response("net"));
    message(listeners, null);
    message(listeners, { type: "decision" }); // no socket yet: nothing happens
    message(listeners, { type: "broker-connect", url: "ws://b" });
    const socket = only(sockets);
    socket.open();
    clientMessages.length = 0;
    socket.emit("message", { data: "not json" });
    await flush();
    expect(clientMessages.some((m) => (m as { type: string }).type === "broker-event")).toBe(false);
  });

  it("broadcasts a closed status and attempts to reconnect when the socket drops", async () => {
    const { listeners, sockets, clientMessages } = createScope(async () => new Response("net"));
    message(listeners, { type: "broker-connect", url: "ws://b" });
    const socket = only(sockets);
    socket.open();
    socket.close();
    await flush();
    expect(
      clientMessages.some(
        (m) =>
          (m as { type: string; status?: string }).type === "broker-status" &&
          (m as { status?: string }).status === "closed",
      ),
    ).toBe(true);
  });
});

// A request whose flagged-fragment count we control, to exercise the four-line
// cap and the "+N more" overflow tail.
function shellRequestWithFlagged(count: number) {
  return {
    id: "req-shell",
    protocol_version: 3,
    subject: "shell",
    harness: "claude-code",
    cwd: "/workspace/acme-api",
    command: "scripted",
    current_verdict: "ask",
    current_reason: "needs approval",
    fragments: Array.from({ length: count }, (_, i) => ({
      display: `risky-command-${i}`,
      argv: ["risky-command", String(i)],
      role: "standalone",
      verdict: "ask",
      rule: null,
      reason: "needs approval",
    })),
  };
}

const toolPayload = brokerRequestPayloads[2] as {
  id: string;
  tool: { name: string; raw: Record<string, unknown> };
};

type NotificationLike = { data?: { requestId?: string }; close: ReturnType<typeof vi.fn> };

async function notificationClick(
  listeners: Record<string, (event: SwEvent) => void>,
  notification: NotificationLike,
  action?: string,
) {
  const pending: Promise<unknown>[] = [];
  (listeners.notificationclick as unknown as (event: unknown) => void)?.({
    notification,
    action,
    waitUntil: (p: Promise<unknown>) => pending.push(p),
  });
  await Promise.all(pending);
}

// Connect, open the socket, and return it ready to receive broker frames.
function openBroker(listeners: Record<string, (event: SwEvent) => void>, sockets: FakeWebSocket[]) {
  message(listeners, { type: "broker-connect", url: "ws://b" });
  const socket = only(sockets);
  socket.open();
  return socket;
}

describe("service worker approval notifications", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("raises a notification previewing up to four fragments with an overflow tail", async () => {
    const { listeners, sockets, shownNotifications } = createScope(async () => new Response("net"));
    const socket = openBroker(listeners, sockets);

    socket.emit("message", {
      data: JSON.stringify({ type: "added", request: shellRequestWithFlagged(6) }),
    });
    await flush();

    const notification = only(shownNotifications);
    const lines = String(notification.options.body).split("\n");
    expect(lines).toHaveLength(5); // four fragments + the overflow tail
    expect(lines.slice(0, 4)).toEqual([
      "risky-command-0",
      "risky-command-1",
      "risky-command-2",
      "risky-command-3",
    ]);
    expect(lines[4]).toBe("+2 more");
  });

  it("attaches Approve/Deny actions and tags the notification with the request id", async () => {
    const { listeners, sockets, shownNotifications } = createScope(async () => new Response("net"));
    const socket = openBroker(listeners, sockets);

    socket.emit("message", {
      data: JSON.stringify({ type: "added", request: shellRequestWithFlagged(1) }),
    });
    await flush();

    const { options } = only(shownNotifications);
    expect(options.actions).toEqual([
      { action: "allow", title: "Approve" },
      { action: "deny", title: "Deny" },
    ]);
    expect(options.tag).toBe("req-shell");
    expect(options.data).toEqual({ requestId: "req-shell" });
  });

  it("previews a tool call's arguments and titles it with the tool name", async () => {
    const { listeners, sockets, shownNotifications } = createScope(async () => new Response("net"));
    const socket = openBroker(listeners, sockets);

    socket.emit("message", { data: JSON.stringify({ type: "added", request: toolPayload }) });
    await flush();

    const notification = only(shownNotifications);
    expect(notification.title).toBe(`${toolPayload.tool.name} · claude-code`);
    const lines = String(notification.options.body).split("\n");
    for (const [key, value] of Object.entries(toolPayload.tool.raw)) {
      expect(lines).toContain(`${key} = ${value}`);
    }
  });

  it("does not notify on a snapshot — only on a freshly added request", async () => {
    const { listeners, sockets, registration } = createScope(async () => new Response("net"));
    const socket = openBroker(listeners, sockets);

    socket.emit("message", {
      data: JSON.stringify({ type: "snapshot", requests: [shellRequestWithFlagged(1)] }),
    });
    await flush();
    expect(registration.showNotification).not.toHaveBeenCalled();
  });

  it("does not notify while a PWA window is focused", async () => {
    const { listeners, sockets, registration, clientList } = createScope(
      async () => new Response("net"),
    );
    only(clientList).focused = true;
    const socket = openBroker(listeners, sockets);

    socket.emit("message", {
      data: JSON.stringify({ type: "added", request: shellRequestWithFlagged(1) }),
    });
    await flush();
    expect(registration.showNotification).not.toHaveBeenCalled();
  });

  it("closes the matching notification when the request is resolved", async () => {
    const { listeners, sockets, shownNotifications, registration } = createScope(
      async () => new Response("net"),
    );
    const socket = openBroker(listeners, sockets);

    socket.emit("message", {
      data: JSON.stringify({ type: "added", request: shellRequestWithFlagged(1) }),
    });
    await flush();
    const notification = only(shownNotifications);

    socket.emit("message", { data: JSON.stringify({ type: "resolved", requestId: "req-shell" }) });
    await flush();
    expect(registration.getNotifications).toHaveBeenCalledWith({ tag: "req-shell" });
    expect(notification.close).toHaveBeenCalled();
  });

  it("decides a request straight from a notification action", async () => {
    const { listeners, sockets } = createScope(async () => new Response("net"));
    const socket = openBroker(listeners, sockets);
    const notification: NotificationLike = { data: { requestId: "req-shell" }, close: vi.fn() };

    await notificationClick(listeners, notification, "allow");

    expect(notification.close).toHaveBeenCalled();
    expect(socket.sent).toContain(
      JSON.stringify({
        type: "decision",
        requestId: "req-shell",
        verdict: "allow",
        reason: "allowed from notification",
      }),
    );
  });

  it("focuses an open window when the notification body is clicked", async () => {
    const { listeners, sockets, clientList } = createScope(async () => new Response("net"));
    openBroker(listeners, sockets);
    const notification: NotificationLike = { data: { requestId: "req-shell" }, close: vi.fn() };

    await notificationClick(listeners, notification);
    expect(only(clientList).focus).toHaveBeenCalled();
  });

  it("opens a window when the body is clicked and no window is open", async () => {
    const { listeners, sockets, clientList, self } = createScope(async () => new Response("net"));
    openBroker(listeners, sockets);
    clientList.length = 0; // no open windows
    const notification: NotificationLike = { data: { requestId: "req-shell" }, close: vi.fn() };

    await notificationClick(listeners, notification);
    expect(self.clients.openWindow).toHaveBeenCalledWith("/");
  });

  it("falls back to focusing when an action is clicked but the socket is closed", async () => {
    const { listeners, sockets, clientList } = createScope(async () => new Response("net"));
    // Connect but never open the socket, so the decision cannot be sent.
    message(listeners, { type: "broker-connect", url: "ws://b" });
    only(sockets);
    const notification: NotificationLike = { data: { requestId: "req-shell" }, close: vi.fn() };

    await notificationClick(listeners, notification, "deny");
    expect(only(clientList).focus).toHaveBeenCalled();
  });
});
