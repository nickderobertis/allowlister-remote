import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";

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

// Fixed port shared with playwright.config.ts's webServer env so /api/config
// returns this broker's /ws/pwa endpoint at runtime.
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
function runPlugin(command: string) {
  const child = spawn(pluginBin, ["--daemon-socket", socketPath], {
    env: { ...process.env, NO_COLOR: "1" },
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  child.stdin.write(
    JSON.stringify({
      subject: "shell",
      current_verdict: "defer",
      command,
      project: "github.com/acme/repo",
    }),
  );
  child.stdin.end();
  return {
    promise: new Promise<{ code: number | null; stdout: string }>((resolveExit) => {
      child.on("close", (code) => resolveExit({ code, stdout }));
    }),
    kill: () => child.kill(),
  };
}

async function expectStillRunning(running: { promise: Promise<unknown> }) {
  const marker = Symbol("running");
  const result = await Promise.race([
    running.promise,
    new Promise<typeof marker>((r) => setTimeout(() => r(marker), 1000)),
  ]);
  expect(result, "plugin should still be waiting for a decision").toBe(marker);
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
  await waitForPort(brokerPort);

  daemon = spawn(daemonBin, [], {
    env: {
      ...process.env,
      ALLOWLISTER_REMOTE_DAEMON_SOCK: socketPath,
      ALLOWLISTER_REMOTE_BROKER_URL: `ws://127.0.0.1:${brokerPort}/ws/daemon`,
    },
    stdio: "ignore",
  });
  await waitForSocket();
});

test.afterAll(async () => {
  daemon?.kill();
  broker?.kill();
  await rm(socketPath, { force: true });
});

test("a plugin request appears via the broker and an allow click releases it", async ({ page }) => {
  const command = `gh pr merge ${randomUUID().slice(0, 8)}`;

  const running = runPlugin(command);
  try {
    // The request is open and the plugin is blocked, before the browser subscribes.
    await expectStillRunning(running);

    // Load the app and make sure the service worker controls the page, so the
    // live-sync effect can hand it the broker connection.
    await page.goto("/");
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await page.evaluate(() => navigator.serviceWorker.ready);

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

test("two PWA clients both see a request and either can resolve it", async ({ browser }) => {
  const command = `npm publish ${randomUUID().slice(0, 8)}`;

  // Two independent browsers (two PWA instances), each with its own service
  // worker holding its own WebSocket to the broker.
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  const running = runPlugin(command);
  try {
    await expectStillRunning(running);

    for (const page of [pageA, pageB]) {
      await page.goto("/");
      await page.evaluate(() => navigator.serviceWorker.ready);
      await page.reload();
      await page.evaluate(() => navigator.serviceWorker.ready);
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
