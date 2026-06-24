import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, type Page } from "@playwright/test";

// The plugin/daemon IPC channel is a Unix-domain socket on Unix and a named pipe
// on Windows (see the daemon's accept_plugins #[cfg]s), so the harness picks the
// matching address shape and readiness probe per platform. Built binaries also
// carry the `.exe` suffix on Windows.
const isWindows = process.platform === "win32";
const exe = isWindows ? ".exe" : "";

// Shared harness for the realtime e2e: the broker and daemon binaries, the plugin
// binary in daemon mode, and the helpers a spec needs to open a request and let a
// real Chromium page (driven by the real service worker over the broker
// WebSocket) decide it. Both broker-realtime.spec.ts and notifications.spec.ts
// build one of these on their own port so they never share broker state.

const root = resolve(import.meta.dirname, "../../..");
const targetDir = join(root, "target", "debug");
// Honor the *_BIN env overrides so the post-release smoke drives the published
// plugin and daemon binaries (the broker is server-side, built from source).
const brokerBin =
  process.env.ALLOWLISTER_REMOTE_BROKER_BIN ?? join(targetDir, `allowlister-remote-broker${exe}`);
const daemonBin =
  process.env.ALLOWLISTER_REMOTE_DAEMON_BIN ?? join(targetDir, `allowlister-remote-daemon${exe}`);
const pluginBin =
  process.env.ALLOWLISTER_REMOTE_PLUGIN_BIN ?? join(targetDir, `allowlister-remote-plugin${exe}`);

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

// A bound Unix socket shows up on the filesystem, but a Windows named pipe does
// not — and fs.existsSync/readdir over the `\\.\pipe\` namespace is unreliable.
// Probe readiness with a real client connection instead: the daemon's accept
// loop pre-creates a fresh pipe instance right after each connect, so this
// throwaway probe never steals the instance the plugin will use.
function socketReady(socketPath: string): Promise<boolean> {
  if (!isWindows) return Promise.resolve(existsSync(socketPath));
  return new Promise((resolve) => {
    const probe = createConnection(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => {
      probe.destroy();
      resolve(false);
    });
  });
}

async function waitForSocket(socketPath: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await socketReady(socketPath)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`daemon socket ${socketPath} never appeared`);
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

export interface RunningPlugin {
  promise: Promise<{ code: number | null; stdout: string }>;
  kill: () => void;
}

export interface BrokerHarness {
  /** Build the broker and daemon binaries if missing, then start both. */
  start(): Promise<void>;
  /** Tear down the daemon, broker, and socket. */
  stop(): Promise<void>;
  /** Spawn a plugin that opens `payload` as a request and blocks for a decision. */
  runPlugin(payload: Record<string, unknown>): RunningPlugin;
  /** The common case: a shell command allowlister deferred to remote approval. */
  runShell(command: string): RunningPlugin;
  /** Make the page's service worker control it and dial this harness's broker. */
  subscribe(page: Page): Promise<void>;
  /** Assert the plugin is still blocked (no side has decided yet). */
  expectStillRunning(running: RunningPlugin): Promise<void>;
}

export function createBrokerHarness(brokerPort: number): BrokerHarness {
  const pipeName = `allowlister-remote-e2e-${randomUUID().slice(0, 8)}`;
  const socketPath = isWindows ? `\\\\.\\pipe\\${pipeName}` : join(tmpdir(), `${pipeName}.sock`);
  let broker: ChildProcess | undefined;
  let daemon: ChildProcess | undefined;

  // Reap both long-lived processes (and the Unix socket file). Shared by stop()
  // and by start()'s failure path, so a harness that throws mid-startup never
  // leaks a broker/daemon that would hold the runner's pipes open and hang it.
  async function teardown() {
    await Promise.all([terminate(daemon), terminate(broker)]);
    // A Unix socket is a real file to unlink; a Windows named pipe is torn down
    // with the daemon process, and rm() on a `\\.\pipe\` path would throw.
    if (!isWindows) await rm(socketPath, { force: true });
  }

  function runPlugin(payload: Record<string, unknown>): RunningPlugin {
    const child = spawn(pluginBin, ["--daemon-socket", socketPath], {
      env: { ...process.env, NO_COLOR: "1" },
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
    return {
      promise: new Promise((resolveExit) => {
        child.on("close", (code) => resolveExit({ code, stdout }));
      }),
      kill: () => child.kill(),
    };
  }

  return {
    runPlugin,
    runShell(command: string) {
      return runPlugin({
        subject: "shell",
        current_verdict: "ask",
        command,
        cwd: "/workspace/repo",
      });
    },
    async subscribe(page: Page) {
      // The broker URL is a per-device client setting; seed it before any load so
      // the app (and the service worker it spawns) dials this harness's broker. A
      // reload is needed because the first load registers the worker but is not
      // yet controlled by it.
      await page.addInitScript((port) => {
        window.localStorage.setItem("allowlister-remote-broker-url", `ws://127.0.0.1:${port}`);
      }, brokerPort);
      await page.goto("/");
      await page.evaluate(() => navigator.serviceWorker.ready);
      await page.reload();
      await page.evaluate(() => navigator.serviceWorker.ready);
    },
    async expectStillRunning(running: RunningPlugin) {
      const marker = Symbol("running");
      const result = await Promise.race([
        running.promise,
        new Promise<typeof marker>((r) => setTimeout(() => r(marker), 1000)),
      ]);
      expect(result, "plugin should still be waiting for a decision").toBe(marker);
    },
    async start() {
      for (const [bin, pkg] of [
        [brokerBin, "allowlister-remote-broker"],
        [daemonBin, "allowlister-remote-daemon"],
        [pluginBin, "allowlister-remote-plugin"],
      ] as const) {
        if (!existsSync(bin)) await run("cargo", ["build", "-p", pkg]);
      }

      // If readiness ever fails, reap whatever did start before rethrowing, so a
      // startup failure surfaces as a fast error instead of a leaked-process hang.
      try {
        broker = spawn(brokerBin, [], {
          env: { ...process.env, ALLOWLISTER_REMOTE_BROKER_ADDR: `127.0.0.1:${brokerPort}` },
          stdio: "ignore",
        });
        // Don't let the long-lived broker/daemon handles keep the Node runner
        // alive on their own; teardown still kills them, this removes the hang.
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
        await waitForSocket(socketPath);
      } catch (err) {
        await teardown();
        throw err;
      }
    },
    async stop() {
      await teardown();
    },
  };
}
