import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createBrokerHarness } from "./broker-harness";

// The realtime path with every real component in the loop: the broker and daemon
// binaries, the plugin binary in daemon mode, the Next app, and — crucially — the
// real service worker holding the WebSocket to the broker. This is the browser
// counterpart to the Rust process-level e2e (crates/allowlister-remote-e2e):
// here the decision is made by a human-style click in a real Chromium page and
// must travel SW → broker → daemon → plugin.

const harness = createBrokerHarness(4188);
const { runPlugin, runShell, subscribe, expectStillRunning } = harness;

test.beforeAll(async () => {
  test.setTimeout(180_000); // the first run may compile the broker/daemon binaries
  await harness.start();
});

test.afterAll(async () => {
  await harness.stop();
});

test("a plugin request appears via the broker and an allow click releases it", async ({ page }) => {
  const command = `gh pr merge ${randomUUID().slice(0, 8)}`;

  const running = runShell(command);
  try {
    // The request is open and the plugin is blocked, before the browser subscribes.
    await expectStillRunning(running);

    await subscribe(page);

    // The request arrives over the broker (snapshot on subscribe) and renders.
    const list = page.getByRole("list", { name: "Pending approvals" });
    await expect(list.getByText(command, { exact: true })).toBeVisible({ timeout: 20_000 });

    // Approving sends the decision back through the broker to the waiting plugin.
    await page.getByRole("button", { name: `Allow ${command}` }).click();

    const result = await running.promise;
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).verdict).toBe("allow");

    // The card clears from the inbox once resolved.
    await expect(list.getByText(command, { exact: true })).toHaveCount(0);
  } finally {
    running.kill();
  }
});

test("a deny decision travels back through the broker to the plugin", async ({ page }) => {
  const command = `rm -rf ${randomUUID().slice(0, 8)}`;

  const running = runShell(command);
  try {
    await expectStillRunning(running);
    await subscribe(page);

    // Open the expanded detail view, then deny from its decision bar.
    const list = page.getByRole("list", { name: "Pending approvals" });
    await expect(list.getByText(command, { exact: true })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: `Open approval for ${command}` }).click();
    await page.getByRole("button", { name: "Deny", exact: true }).click();

    const result = await running.promise;
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).verdict).toBe("deny");
  } finally {
    running.kill();
  }
});

test("a tool-call request renders over the broker and resolves", async ({ page }) => {
  const toolName = `mcp__github__create_issue_${randomUUID().slice(0, 8)}`;

  const running = runPlugin({
    subject: "tool",
    current_verdict: "ask",
    cwd: "/workspace/repo",
    tool: {
      name: toolName,
      capability: "mcp",
      params: {},
      raw: { title: "Production is down", owner: "acme" },
    },
  });
  try {
    await expectStillRunning(running);
    await subscribe(page);

    // The tool call arrives over the broker and the detail view shows its input.
    await page.getByRole("button", { name: `Open approval for ${toolName}` }).click();
    await expect(page.getByText("Approve this tool call")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Production is down")).toBeVisible();

    await page.getByRole("button", { name: "Allow once" }).click();

    const result = await running.promise;
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).verdict).toBe("allow");
  } finally {
    running.kill();
  }
});

test("two PWA clients both see a request and either can resolve it", async ({ browser }) => {
  const command = `npm publish ${randomUUID().slice(0, 8)}`;

  // Two independent browsers (two PWA instances), each with its own service
  // worker holding its own WebSocket to the broker.
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  const running = runShell(command);
  try {
    await expectStillRunning(running);

    for (const page of [pageA, pageB]) {
      await subscribe(page);
    }

    const listA = pageA.getByRole("list", { name: "Pending approvals" });
    const listB = pageB.getByRole("list", { name: "Pending approvals" });

    // Both PWAs receive the same daemon's request.
    await expect(listA.getByText(command, { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(listB.getByText(command, { exact: true })).toBeVisible({ timeout: 20_000 });

    // One PWA decides; the plugin is released and the card clears on BOTH PWAs.
    await pageA.getByRole("button", { name: `Allow ${command}` }).click();

    const result = await running.promise;
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).verdict).toBe("allow");

    await expect(listA.getByText(command, { exact: true })).toHaveCount(0);
    await expect(listB.getByText(command, { exact: true })).toHaveCount(0);
  } finally {
    running.kill();
    await contextA.close();
    await contextB.close();
  }
});

test("a request opened while the PWA is watching arrives live", async ({ page }) => {
  // The existing tests subscribe after the request exists (the broker `snapshot`
  // on subscribe). This exercises the `added` fan-out: subscribe to an empty
  // inbox first, then open a request and watch it appear without a reload.
  await subscribe(page);
  await expect(page.getByRole("heading", { name: "No pending approvals" })).toBeVisible();

  const command = `kubectl delete ns ${randomUUID().slice(0, 8)}`;
  const running = runShell(command);
  try {
    const list = page.getByRole("list", { name: "Pending approvals" });
    await expect(list.getByText(command, { exact: true })).toBeVisible({ timeout: 20_000 });

    await page.getByRole("button", { name: `Allow ${command}` }).click();
    const result = await running.promise;
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).verdict).toBe("allow");
  } finally {
    running.kill();
  }
});

test("concurrent requests from one daemon resolve independently", async ({ page }) => {
  // Several plugins open requests through the same daemon at once. Each is its own
  // card; deciding one must release only that plugin and clear only its card,
  // proving the daemon's multiplexing and the broker's per-request routing.
  const commands = [0, 1, 2].map((i) => `terraform destroy ${i} ${randomUUID().slice(0, 8)}`);
  const running = commands.map((command) => runShell(command));
  try {
    for (const r of running) await expectStillRunning(r);
    await subscribe(page);

    const list = page.getByRole("list", { name: "Pending approvals" });
    for (const command of commands) {
      await expect(list.getByText(command, { exact: true })).toBeVisible({ timeout: 20_000 });
    }

    // Deny the middle one: only its plugin resolves, only its card clears.
    await page.getByRole("button", { name: `Deny ${commands[1]}` }).click();

    const result = await running[1].promise;
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).verdict).toBe("deny");

    await expect(list.getByText(commands[1], { exact: true })).toHaveCount(0);
    // The other two are untouched: still on screen and still blocking their plugins.
    await expect(list.getByText(commands[0], { exact: true })).toBeVisible();
    await expect(list.getByText(commands[2], { exact: true })).toBeVisible();
    await expectStillRunning(running[0]);
    await expectStillRunning(running[2]);
  } finally {
    for (const r of running) r.kill();
  }
});

test("a reload onto an already-open broker socket shows Connected, not a stuck Connecting", async ({
  page,
}) => {
  // Regression guard. The service worker holds one socket shared across a
  // browser's tabs and reloads, and it broadcast `broker-status: open` only at the
  // instant that socket opened. A page that attached to an already-open socket (a
  // reload, or a second tab) hit connectBroker's early return and was never
  // re-told the status, so it sat forever on "Connecting to broker…" even though
  // broker events kept arriving — the requests showed up while the banner lied.
  // The other tests only assert that requests arrive (the broker-event relay,
  // which works even with the bug), so this asserts the *status label* itself.
  await subscribe(page);

  // First load: the socket opens and the page goes online.
  await expect(page.getByText("Connected to broker")).toBeVisible({ timeout: 20_000 });

  // Reload onto the *already-open* shared socket — the late-subscriber path. The
  // freshly loaded page resets to "Connecting to broker…" and must be re-told the
  // socket is already open; with the regression it stays there indefinitely.
  await page.reload();
  await page.evaluate(() => navigator.serviceWorker.ready);

  await expect(page.getByText("Connected to broker")).toBeVisible({ timeout: 20_000 });
});

test("a plugin that exits withdraws its card from the PWA", async ({ page }) => {
  // If the gated command is cancelled (the plugin process dies) before anyone
  // decides, the daemon withdraws the request and the broker tells every PWA to
  // drop the card — no dead prompt is left behind.
  const command = `rm -rf / ${randomUUID().slice(0, 8)}`;
  const running = runShell(command);
  try {
    await expectStillRunning(running);
    await subscribe(page);

    const list = page.getByRole("list", { name: "Pending approvals" });
    await expect(list.getByText(command, { exact: true })).toBeVisible({ timeout: 20_000 });

    // The plugin process dies before any decision.
    running.kill();
    await running.promise;

    // The daemon's withdraw → broker `resolved` clears the card live.
    await expect(list.getByText(command, { exact: true })).toHaveCount(0, { timeout: 20_000 });
  } finally {
    running.kill();
  }
});
