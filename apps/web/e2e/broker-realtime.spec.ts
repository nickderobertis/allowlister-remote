import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";

// The realtime path with every real component in the loop: the broker and daemon
// binaries, the plugin binary in daemon mode, the Next app, and — crucially — the
// real service worker holding the WebSocket to the broker. This is the browser
// counterpart to the Rust process-level e2e (crates/allowlister-remote-e2e):
// here the decision is made by a human-style click in a real Chromium page and
// must travel SW → broker → daemon → plugin.

const root = resolve(import.meta.dirname, "../../..");
const targetDir = join(root, "target", "debug");
// Honor the *_BIN env overrides so the post-release smoke drives the published
// plugin and daemon binaries (the broker is server-side, built from source).
const brokerBin =
  process.env.ALLOWLISTER_REMOTE_BROKER_BIN ?? join(targetDir, "allowlister-remote-broker");
const daemonBin =
  process.env.ALLOWLISTER_REMOTE_DAEMON_BIN ?? join(targetDir, "allowlister-remote-daemon");
const pluginBin =
  process.env.ALLOWLISTER_REMOTE_PLUGIN_BIN ?? join(targetDir, "allowlister-remote-plugin");

const socketPath = join(tmpdir(), `allowlister-remote-e2e-${randomUUID().slice(0, 8)}.sock`);

// Fixed port for the broker this spec runs; each page is told to use it via a
// client-side setting (localStorage) seeded in `subscribe` before navigation.
const brokerPort = 4188;
let broker: ChildProcess | undefined;
let daemon: ChildProcess | undefined;

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.on("close", (code) =>
      code === 0 ? resolveRun() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}

async function waitForPort(port: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const open = await new Promise<boolean>((resolveOpen) => {
      const socket = createConnection({ port, host: "127.0.0.1" }, () => {
        socket.end();
        resolveOpen(true);
      });
      socket.on("error", () => resolveOpen(false));
    });
    if (open) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`broker port ${port} never opened`);
}

async function waitForSocket(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (existsSync(socketPath)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`daemon socket ${socketPath} never appeared`);
}

// Spawn the plugin in daemon mode. It opens an approval request and blocks until
// a decision is relayed back, printing the verdict JSON on exit.
function runPlugin(payload: Record<string, unknown>) {
  const child = spawn(pluginBin, ["--daemon-socket", socketPath], {
    env: { ...process.env, NO_COLOR: "1" },
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  child.stdin.write(JSON.stringify(payload));
  child.stdin.end();
  return {
    promise: new Promise<{ code: number | null; stdout: string }>((resolveExit) => {
      child.on("close", (code) => resolveExit({ code, stdout }));
    }),
    kill: () => child.kill(),
  };
}

// The common case: a shell command allowlister deferred to remote approval.
function runShell(command: string) {
  return runPlugin({
    subject: "shell",
    current_verdict: "defer",
    command,
    cwd: "/workspace/repo",
  });
}

// Make the page's service worker control it, so the live-sync effect can hand it
// the broker connection. A reload is needed because the first load registers the
// worker but is not yet controlled by it.
async function subscribe(page: Page) {
  // The broker URL is a per-device client setting; seed it before any load so the
  // app (and the service worker it spawns) dials this spec's broker.
  await page.addInitScript((port) => {
    window.localStorage.setItem("allowlister-remote-broker-url", `ws://127.0.0.1:${port}`);
  }, brokerPort);
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.evaluate(() => navigator.serviceWorker.ready);
}

async function expectStillRunning(running: { promise: Promise<unknown> }) {
  const marker = Symbol("running");
  const result = await Promise.race([
    running.promise,
    new Promise<typeof marker>((r) => setTimeout(() => r(marker), 1000)),
  ]);
  expect(result, "plugin should still be waiting for a decision").toBe(marker);
}

// Force-kill a spawned child and wait (bounded) for it to exit. A long-lived
// broker/daemon left running would otherwise keep the Playwright runner alive
// past the suite; SIGKILL is uncatchable, and the timeout never lets teardown
// itself hang.
async function terminate(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveClose) => {
    child.once("close", () => resolveClose());
    child.kill("SIGKILL");
    setTimeout(() => resolveClose(), 2000).unref();
  });
}

test.beforeAll(async () => {
  test.setTimeout(180_000); // the first run may compile the broker/daemon binaries

  for (const [bin, pkg] of [
    [brokerBin, "allowlister-remote-broker"],
    [daemonBin, "allowlister-remote-daemon"],
    [pluginBin, "allowlister-remote-plugin"],
  ] as const) {
    if (!existsSync(bin)) await run("cargo", ["build", "-p", pkg]);
  }

  broker = spawn(brokerBin, [], {
    env: { ...process.env, ALLOWLISTER_REMOTE_BROKER_ADDR: `127.0.0.1:${brokerPort}` },
    stdio: "ignore",
  });
  // Don't let the long-lived broker/daemon handles keep the Node runner alive on
  // their own; afterAll still kills them, this just removes the leak as a hang.
  broker.unref();
  await waitForPort(brokerPort);

  daemon = spawn(daemonBin, [], {
    env: {
      ...process.env,
      ALLOWLISTER_REMOTE_DAEMON_SOCK: socketPath,
      ALLOWLISTER_REMOTE_BROKER_URL: `ws://127.0.0.1:${brokerPort}/ws/daemon`,
    },
    stdio: "ignore",
  });
  daemon.unref();
  await waitForSocket();
});

test.afterAll(async () => {
  await Promise.all([terminate(daemon), terminate(broker)]);
  await rm(socketPath, { force: true });
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
    current_verdict: "defer",
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
