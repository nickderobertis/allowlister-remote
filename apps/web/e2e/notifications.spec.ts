import { randomUUID } from "node:crypto";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { createBrokerHarness } from "./broker-harness";

// The service worker raises an OS notification (with Approve/Deny actions) for
// each incoming request and can decide it straight from those buttons. Playwright
// can neither read nor click a real OS notification, so these tests drive the
// *live* service worker directly against the same real broker/daemon/plugin: they
// prove it builds the right notification from a real broker-delivered request,
// that Chrome accepts and round-trips it (actions + data), that a foregrounded
// inbox suppresses the duplicate, and that the worker's real `notificationclick`
// handler routes a decision back through the broker to the waiting plugin. The one
// hop only manual testing can cover is Chrome populating `event.action` from a
// literal button press — see docs/notifications.md.

// New headless Chromium ("chromium" channel) is required for the Notifications
// API; old headless hard-denies the permission. Set at file scope because a
// channel switch forces its own Playwright worker.
test.use({ channel: "chromium" });

// Its own broker port so it never shares state with broker-realtime.spec.ts.
const harness = createBrokerHarness(4189);
const { runPlugin, runShell, subscribe } = harness;

test.beforeAll(async () => {
  test.setTimeout(180_000); // the first run may compile the broker/daemon binaries
  await harness.start();
});

test.afterAll(async () => {
  await harness.stop();
});

// Notifications are not viewport-specific; assert them once on desktop rather than
// doubling these heavy real-binary runs on the mobile project too.
test.beforeEach(({ browser: _browser }, testInfo) => {
  test.skip(
    testInfo.project.name === "mobile-chrome",
    "notification behavior is asserted once on chromium-desktop",
  );
});

type NotificationContentFn = (request: unknown) => { title: string; options: NotificationOptions };
type ServiceWorkerScope = {
  notificationContent: NotificationContentFn;
  registration: ServiceWorkerRegistration;
};

// Record every request the broker pushes to this page (its `added` fan-out and the
// `snapshot` on subscribe), so a test can read the daemon-assigned id and the
// verbatim payload the service worker actually received.
async function captureBrokerRequests(page: Page) {
  await page.addInitScript(() => {
    const store: unknown[] = [];
    (window as unknown as { __added: unknown[] }).__added = store;
    navigator.serviceWorker.addEventListener("message", (event) => {
      const data = (event as MessageEvent).data;
      if (data?.type !== "broker-event") return;
      const brokerEvent = data.event;
      if (brokerEvent?.type === "added") store.push(brokerEvent.request);
      else if (brokerEvent?.type === "snapshot")
        for (const request of brokerEvent.requests ?? []) store.push(request);
    });
  });
}

async function firstDeliveredRequest(page: Page): Promise<{ id: string; harness: string }> {
  const handle = await page.waitForFunction(
    () => (window as unknown as { __added: unknown[] }).__added[0] ?? null,
    null,
    { timeout: 20_000 },
  );
  return handle.jsonValue() as Promise<{ id: string; harness: string }>;
}

async function liveServiceWorker(context: BrowserContext) {
  return context.serviceWorkers()[0] ?? context.waitForEvent("serviceworker");
}

async function shownNotificationCount(context: BrowserContext): Promise<number> {
  const worker = await liveServiceWorker(context);
  return worker.evaluate(async () => {
    const scope = self as unknown as ServiceWorkerScope;
    return (await scope.registration.getNotifications()).length;
  });
}

test("builds and shows the approval notification from the live broker request", async ({
  page,
  context,
  baseURL,
}) => {
  const tag = randomUUID().slice(0, 8);
  // Six flagged fragments so the notification body exercises the four-line cap and
  // the "+N more" overflow tail.
  const fragments = Array.from({ length: 6 }, (_, i) => ({
    display: `kubectl apply -f manifest-${i}-${tag}.yaml`,
    argv: ["kubectl", "apply", "-f", `manifest-${i}-${tag}.yaml`],
    role: "standalone",
    verdict: "ask",
    rule: "ask before applying kubernetes manifests",
    reason: "needs approval",
  }));

  await context.grantPermissions(["notifications"], { origin: baseURL ?? undefined });
  await captureBrokerRequests(page);
  await subscribe(page);

  const running = runPlugin({
    subject: "shell",
    current_verdict: "ask",
    harness: "claude-code",
    cwd: "/workspace/repo",
    command: fragments.map((fragment) => fragment.display).join("\n"),
    fragments,
  });
  try {
    const request = await firstDeliveredRequest(page);
    const worker = await liveServiceWorker(context);

    // Build the notification with the real production function in the live worker,
    // show it, and read back what Chrome actually stored.
    const shown = await worker.evaluate(async (req) => {
      const scope = self as unknown as ServiceWorkerScope;
      const { title, options } = scope.notificationContent(req);
      await scope.registration.showNotification(title, options);
      const notifications = await scope.registration.getNotifications();
      return {
        title,
        body: String(options.body ?? ""),
        stored: notifications.map((n) => ({
          tag: n.tag,
          data: n.data,
          actions: n.actions.map((action) => ({ action: action.action, title: action.title })),
        })),
      };
    }, request);

    const lines = shown.body.split("\n");
    expect(lines).toHaveLength(5); // four fragments + the overflow tail
    expect(lines[4]).toBe("+2 more");
    expect(shown.title).toBe("Shell approval · claude-code");
    expect(shown.stored).toHaveLength(1);
    expect(shown.stored[0]?.tag).toBe(request.id);
    expect(shown.stored[0]?.data).toEqual({ requestId: request.id });
    expect(shown.stored[0]?.actions).toEqual([
      { action: "allow", title: "Approve" },
      { action: "deny", title: "Deny" },
    ]);
  } finally {
    running.kill();
  }
});

test("a notification action decides the request through the broker to the plugin", async ({
  page,
  context,
  baseURL,
}) => {
  await context.grantPermissions(["notifications"], { origin: baseURL ?? undefined });
  await captureBrokerRequests(page);
  await subscribe(page);

  const command = `helm upgrade ${randomUUID().slice(0, 8)}`;
  const running = runShell(command);
  try {
    const list = page.getByRole("list", { name: "Pending approvals" });
    await expect(list.getByText(command, { exact: true })).toBeVisible({ timeout: 20_000 });
    const request = await firstDeliveredRequest(page);

    // The inbox is foregrounded, so the live request raised no duplicate OS
    // notification — the visible card already shows it.
    expect(await shownNotificationCount(context)).toBe(0);

    // Clicking the notification's Approve button (what a backgrounded device would
    // tap) decides through the worker's real handler → broker → plugin.
    const worker = await liveServiceWorker(context);
    await worker.evaluate((requestId) => {
      const event = new Event("notificationclick") as Event & Record<string, unknown>;
      event.notification = { data: { requestId }, close() {} };
      event.action = "allow";
      event.waitUntil = () => {};
      self.dispatchEvent(event);
    }, request.id);

    const result = await running.promise;
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).verdict).toBe("allow");
    await expect(list.getByText(command, { exact: true })).toHaveCount(0);
  } finally {
    running.kill();
  }
});

test("resolving a request closes its notification", async ({ page, context, baseURL }) => {
  await context.grantPermissions(["notifications"], { origin: baseURL ?? undefined });
  await captureBrokerRequests(page);
  await subscribe(page);

  const command = `terraform apply ${randomUUID().slice(0, 8)}`;
  const running = runShell(command);
  try {
    const list = page.getByRole("list", { name: "Pending approvals" });
    await expect(list.getByText(command, { exact: true })).toBeVisible({ timeout: 20_000 });
    const request = await firstDeliveredRequest(page);

    // Stand in for the notification a backgrounded device would have shown, tagged
    // with the request id exactly as the worker tags it.
    const worker = await liveServiceWorker(context);
    await worker.evaluate(async (req) => {
      const scope = self as unknown as ServiceWorkerScope;
      const { title, options } = scope.notificationContent(req);
      await scope.registration.showNotification(title, options);
    }, request);
    expect(await shownNotificationCount(context)).toBe(1);

    // Deciding the request makes the broker emit `resolved`; the worker closes the
    // matching notification by tag.
    await page.getByRole("button", { name: `Allow ${command}` }).click();
    await running.promise;
    await expect.poll(() => shownNotificationCount(context), { timeout: 10_000 }).toBe(0);
  } finally {
    running.kill();
  }
});
