import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";

const root = resolve(import.meta.dirname, "../../..");
const plugin =
  process.env.ALLOWLISTER_REMOTE_PLUGIN_BIN ??
  join(root, "target", "debug", "allowlister-remote-plugin");
const serverUrl = "http://127.0.0.1:4183";

// Local-terminal approval requires the plugin to have a controlling terminal,
// which we allocate with util-linux `script`. That is Linux-only, so on other
// platforms only the remote-decision paths run.
const ttyApprovalSupported = process.platform === "linux";

type Running = {
  promise: Promise<{ code: number | null; stdout: string; stderr: string }>;
  kill(): void;
};

type TtyRunning = {
  promise: Promise<{ code: number | null; verdict: string | null; output: string }>;
  output(): string;
  type(input: string): void;
  waitForPrompt(): Promise<void>;
  kill(): void;
};

async function repoConfig(extraRules = "") {
  const dir = await mkdtemp(join(tmpdir(), "allowlister-remote-e2e-"));
  const config = `{
    "rules": [${extraRules}],
    "plugins": [{
      "name": "allowlister remote",
      "command": ["${plugin}", "--server-url", "${serverUrl}", "--poll-ms", "100"],
      "timeout_ms": 35000
    }]
  }`;
  await writeFile(join(dir, ".allowlister.jsonc"), config);
  return { dir };
}

function runAllowlister(cwd: string, command: string): Running {
  const child = spawn("allowlister", ["check", "--cwd", cwd, "--json", command], {
    cwd,
    env: { ...process.env, NO_COLOR: "1" },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  return {
    promise: new Promise((resolveResult) => {
      child.on("close", (code) => resolveResult({ code, stdout, stderr }));
    }),
    kill: () => child.kill(),
  };
}

async function expectStillRunning(running: Running) {
  const marker = Symbol("still-running");
  const result = await Promise.race([
    running.promise,
    new Promise<typeof marker>((resolveMarker) => setTimeout(() => resolveMarker(marker), 1000)),
  ]);
  expect(result).toBe(marker);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// allowlister prints a single `--json` result object on the pty alongside the
// plugin's plain-text prompt (which has no braces), so the result is the run of
// text from the first `{` to the last `}`.
function extractVerdict(output: string): string | null {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(output.slice(start, end + 1).replaceAll("\r", "")) as {
      verdict?: unknown;
    };
    return typeof parsed.verdict === "string" ? parsed.verdict : null;
  } catch {
    return null;
  }
}

// Run allowlister attached to a pseudo-terminal so the plugin presents its
// local approval prompt on /dev/tty while still receiving its stdin from
// allowlister. The pty lets us read that prompt and type a decision.
function runAllowlisterWithTty(cwd: string, command: string): TtyRunning {
  const inner = `allowlister check --cwd ${shellQuote(cwd)} --json ${shellQuote(command)}`;
  const child = spawn("script", ["-qfec", inner, "/dev/null"], {
    cwd,
    env: { ...process.env, NO_COLOR: "1" },
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += String(chunk)));
  child.stderr.on("data", (chunk) => (output += String(chunk)));
  return {
    output: () => output,
    type: (input) => child.stdin.write(input),
    kill: () => child.kill(),
    async waitForPrompt() {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (output.includes("approval required")) return;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      }
      throw new Error(`timed out waiting for the local approval prompt; saw: ${output}`);
    },
    promise: new Promise((resolveResult) => {
      child.on("close", (code) => resolveResult({ code, verdict: extractVerdict(output), output }));
    }),
  };
}

test("allowlister waits for a remote allow decision from the built app", async ({ page }) => {
  const { dir } = await repoConfig();
  const running = runAllowlister(dir, "gh pr merge 42 --squash --delete-branch");
  try {
    await expectStillRunning(running);
    await page.goto("/");
    await expect(page.getByLabel("Important commands")).toContainText("gh pr merge 42");

    await page.getByRole("button", { name: "Allow once" }).click();

    const result = await running.promise;
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).verdict).toBe("allow");
  } finally {
    running.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test("allowlister waits for a remote deny decision from the built app", async ({ page }) => {
  const { dir } = await repoConfig();
  const running = runAllowlister(dir, "gh pr merge 42 --squash --delete-branch");
  try {
    await expectStillRunning(running);
    await page.goto("/");
    await page.getByRole("button", { name: "Deny" }).click();

    const result = await running.promise;
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout).verdict).toBe("deny");
  } finally {
    running.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test("allowlister does not wait for the app when a static allow rule applies", async () => {
  const { dir } = await repoConfig(
    '{"name":"allow git status","match":"git status","action":"allow"}',
  );
  const start = Date.now();
  const running = runAllowlister(dir, "git status");
  try {
    const result = await running.promise;
    expect(Date.now() - start).toBeLessThan(1000);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).verdict).toBe("allow");
  } finally {
    running.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test("allowlister does not wait for the app when a static deny rule applies", async () => {
  const { dir } = await repoConfig('{"name":"deny rm","match":"rm -rf *","action":"deny"}');
  const start = Date.now();
  const running = runAllowlister(dir, "rm -rf build");
  try {
    const result = await running.promise;
    expect(Date.now() - start).toBeLessThan(1000);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout).verdict).toBe("deny");
  } finally {
    running.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test("approving at the local terminal dismisses the pending web approval", async ({ page }) => {
  test.skip(!ttyApprovalSupported, "local-terminal approval needs a Linux pty");
  const { dir } = await repoConfig();
  const running = runAllowlisterWithTty(dir, "gh pr merge 42 --squash --delete-branch");
  try {
    // The local prompt and the web approval appear (almost) simultaneously.
    await running.waitForPrompt();
    expect(running.output()).toContain("[a]llow / [d]eny");
    await page.goto("/");
    await expect(page.getByLabel("Important commands")).toContainText("gh pr merge 42");

    // Deciding at the terminal resolves allowlister and clears the web prompt
    // without anyone touching the browser.
    running.type("a\n");

    const result = await running.promise;
    expect(result.code).toBe(0);
    expect(result.verdict).toBe("allow");
    await expect(page.getByRole("heading", { name: "No pending approvals" })).toBeVisible();
  } finally {
    running.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test("denying at the local terminal returns a deny verdict", async () => {
  test.skip(!ttyApprovalSupported, "local-terminal approval needs a Linux pty");
  const { dir } = await repoConfig();
  const running = runAllowlisterWithTty(dir, "gh pr merge 42 --squash --delete-branch");
  try {
    await running.waitForPrompt();
    running.type("d\n");

    const result = await running.promise;
    expect(result.code).toBe(2);
    expect(result.verdict).toBe("deny");
  } finally {
    running.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a remote decision resolves a request that is also waiting at the terminal", async ({
  page,
}) => {
  test.skip(!ttyApprovalSupported, "local-terminal approval needs a Linux pty");
  const { dir } = await repoConfig();
  const running = runAllowlisterWithTty(dir, "gh pr merge 42 --squash --delete-branch");
  try {
    await running.waitForPrompt();
    await page.goto("/");
    await expect(page.getByLabel("Important commands")).toContainText("gh pr merge 42");

    // Decide remotely; the terminal prompt is dismissed without local input.
    await page.getByRole("button", { name: "Allow once" }).click();

    const result = await running.promise;
    expect(result.code).toBe(0);
    expect(result.verdict).toBe("allow");
    expect(result.output).toContain("Resolved remotely");
  } finally {
    running.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the plugin waits indefinitely with no timeout configured", async () => {
  test.skip(!ttyApprovalSupported, "local-terminal approval needs a Linux pty");
  const { dir } = await repoConfig();
  const running = runAllowlisterWithTty(dir, "gh pr merge 42 --squash --delete-branch");
  try {
    await running.waitForPrompt();
    // No timeout flag is passed, so the request keeps waiting rather than
    // falling back to an `ask` verdict.
    const marker = Symbol("still-waiting");
    const settled = await Promise.race([
      running.promise,
      new Promise<typeof marker>((resolveMarker) => setTimeout(() => resolveMarker(marker), 3000)),
    ]);
    expect(settled).toBe(marker);

    // It still resolves the moment a decision arrives.
    running.type("a\n");
    const result = await running.promise;
    expect(result.verdict).toBe("allow");
  } finally {
    running.kill();
    await rm(dir, { recursive: true, force: true });
  }
});
