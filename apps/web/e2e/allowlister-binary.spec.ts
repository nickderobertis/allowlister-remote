import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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
  // The plugin waits indefinitely for a local or remote decision.
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

// Evaluate a non-shell tool call (`allowlister check --tool …`) instead of a
// shell command, so the e2e drives the real protocol-v3 `tool` payload end to
// end: the binary emits it, the plugin forwards it, and the app renders it.
function runAllowlisterTool(cwd: string, tool: string, raw: string): Running {
  const child = spawn(
    "allowlister",
    ["check", "--cwd", cwd, "--json", "--tool", tool, "--raw", raw],
    {
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
    },
  );
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

async function expectStillRunning(running: Running | TtyRunning) {
  const marker = Symbol("still-running");
  const result = await Promise.race([
    running.promise,
    new Promise<typeof marker>((resolveMarker) => setTimeout(() => resolveMarker(marker), 1000)),
  ]);
  expect(result).toBe(marker);
}

// The Next.js server keeps approval requests in a process-wide in-memory store
// that lives for the whole Playwright run, so every test must use a unique
// command. That way each test only ever matches its own request and is immune
// to undecided requests left behind by other tests (or the desktop/mobile
// projects sharing the same server).
function uniqueCommand(base: string) {
  return `${base} ${randomUUID().slice(0, 8)}`;
}

// A unique MCP tool name per invocation so each test only ever matches its own
// tool request in the process-wide store (the tool name is the inbox headline).
function uniqueTool() {
  return `mcp__github__create_issue_${randomUUID().slice(0, 8)}`;
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

test("allowlister waits for a remote allow decision from the expanded view", async ({ page }) => {
  const { dir } = await repoConfig();
  const command = uniqueCommand("gh pr merge 42 --squash --delete-branch");
  const running = runAllowlister(dir, command);
  try {
    await expectStillRunning(running);
    await page.goto("/");
    const open = page.getByRole("button", { name: `Open approval for ${command}` });
    await expect(open).toHaveCount(1);
    await open.click();
    await expect(page.getByLabel("Flagged commands")).toContainText("gh pr merge 42");

    await page.getByRole("button", { name: "Allow once" }).click();

    const result = await running.promise;
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).verdict).toBe("allow");
  } finally {
    running.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test("surfaces a real tool call and resolves it from the expanded view", async ({ page }) => {
  const { dir } = await repoConfig();
  const tool = uniqueTool();
  const running = runAllowlisterTool(
    dir,
    tool,
    JSON.stringify({ owner: "acme", repo: "app", title: "Production is down" }),
  );
  try {
    await expectStillRunning(running);
    await page.goto("/");
    const open = page.getByRole("button", { name: `Open approval for ${tool}` });
    await expect(open).toHaveCount(1);
    await open.click();

    await expect(page.getByRole("heading", { name: "Approve this tool call" })).toBeVisible();
    // The formatted view shows allowlister's canonical capability mapping...
    await expect(page.getByLabel("Tool call formatted view")).toContainText("capability: mcp");
    // ...and the JSON view shows the verbatim raw input the real binary forwarded.
    await page.getByRole("button", { name: "JSON" }).click();
    await expect(page.getByLabel("Tool call JSON view")).toContainText(
      '"title": "Production is down"',
    );

    await page.getByRole("button", { name: "Allow once" }).click();

    const result = await running.promise;
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).verdict).toBe("allow");
  } finally {
    running.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test("renders a real multi-fragment script with mixed allow/ask verdicts", async ({ page }) => {
  // Most fragments match static allow rules; only `npm publish` and `git push`
  // trip an `ask`, so the engine's real per-fragment decomposition arrives with
  // mixed verdicts rather than a single blob.
  const rules = [
    '{"name":"allow npm install","match":"npm ci","action":"allow"}',
    '{"name":"allow npm build","match":"npm run build","action":"allow"}',
    '{"name":"allow echo","match":"echo *","action":"allow"}',
    '{"name":"ask before publishing a package","match":"npm publish*","action":"ask"}',
    '{"name":"ask before pushing to a remote","match":"git push *","action":"ask"}',
  ].join(",");
  const { dir } = await repoConfig(rules);
  const marker = randomUUID().slice(0, 8);
  // The unique token rides on the first flagged fragment, so the inbox headline
  // (the first ask) is unique per invocation.
  const script = [
    "npm ci",
    "npm run build",
    `npm publish --access public --tag ${marker}`,
    "git push origin main --tags",
    "echo done",
  ].join("\n");
  const headline = `npm publish --access public --tag ${marker}`;
  const running = runAllowlister(dir, script);
  try {
    await expectStillRunning(running);
    await page.goto("/");
    const open = page.getByRole("button", { name: `Open approval for ${headline}` });
    await expect(open).toHaveCount(1);
    await open.click();

    await expect(page.getByRole("heading", { name: "Approve shell command" })).toBeVisible();
    // Only the two tripping fragments are surfaced for attention.
    const flagged = page.getByLabel("Flagged commands");
    await expect(flagged).toContainText(headline);
    await expect(flagged).toContainText("git push origin main --tags");
    // The interactive script lists every fragment including the statically allowed
    // ones, proving mixed verdicts (allow + ask) came through from the real binary.
    // Clicking an allowed fragment discloses the static rule that allowed it.
    const script = page.getByLabel("Script");
    await expect(script).toContainText("npm ci");
    await script.getByRole("button", { name: /npm ci/ }).click();
    await expect(script).toContainText("allow npm install");

    // The script statically resolves to `ask` (rule-driven), and allowlister only
    // lets a plugin `allow` upgrade a static `defer` — so the effective remote
    // decision here is `deny`, which blocks and returns exit code 2.
    await page.getByRole("button", { name: "Deny" }).click();

    const result = await running.promise;
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout).verdict).toBe("deny");
  } finally {
    running.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test("allowlister waits for a remote deny decision from the inbox list", async ({ page }) => {
  const { dir } = await repoConfig();
  const command = uniqueCommand("gh pr merge 42 --squash --delete-branch");
  const running = runAllowlister(dir, command);
  try {
    await expectStillRunning(running);
    await page.goto("/");
    const deny = page.getByRole("button", { name: `Deny ${command}` });
    await expect(deny).toHaveCount(1);
    await deny.click();

    const result = await running.promise;
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout).verdict).toBe("deny");
  } finally {
    running.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolves multiple concurrent allowlister processes independently from the inbox", async ({
  page,
}) => {
  const { dir } = await repoConfig();
  const allowCommand = uniqueCommand("gh pr merge 42 --squash --delete-branch");
  const denyCommand = uniqueCommand("rm -rf build");
  const allowProc = runAllowlister(dir, allowCommand);
  const denyProc = runAllowlister(dir, denyCommand);
  try {
    // Both plugin processes block waiting on the same remote app concurrently.
    await expectStillRunning(allowProc);
    await expectStillRunning(denyProc);

    await page.goto("/");
    const allowOpen = page.getByRole("button", { name: `Open approval for ${allowCommand}` });
    const denyOpen = page.getByRole("button", { name: `Open approval for ${denyCommand}` });
    await expect(allowOpen).toHaveCount(1);
    await expect(denyOpen).toHaveCount(1);

    // Deny one request from the list; the other must stay pending.
    await page.getByRole("button", { name: `Deny ${denyCommand}` }).click();
    await expect(denyOpen).toHaveCount(0);
    await expect(allowOpen).toHaveCount(1);

    const denyResult = await denyProc.promise;
    expect(denyResult.code).toBe(2);
    expect(JSON.parse(denyResult.stdout).verdict).toBe("deny");

    // The remaining process is still blocked until its own decision arrives.
    await expectStillRunning(allowProc);
    await page.getByRole("button", { name: `Allow ${allowCommand}` }).click();
    await expect(allowOpen).toHaveCount(0);

    const allowResult = await allowProc.promise;
    expect(allowResult.code).toBe(0);
    expect(JSON.parse(allowResult.stdout).verdict).toBe("allow");
  } finally {
    allowProc.kill();
    denyProc.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test("surfaces a request that arrives after the inbox is already open", async ({ page }) => {
  const { dir } = await repoConfig();
  const firstCommand = uniqueCommand("gh pr merge 42 --squash --delete-branch");
  const first = runAllowlister(dir, firstCommand);
  try {
    await expectStillRunning(first);
    await page.goto("/");
    const firstOpen = page.getByRole("button", { name: `Open approval for ${firstCommand}` });
    await expect(firstOpen).toHaveCount(1);

    // A second agent hits an approval gate while the operator is already watching
    // the inbox; the polling refresh must surface it without a manual reload.
    const secondCommand = uniqueCommand("rm -rf build");
    const second = runAllowlister(dir, secondCommand);
    try {
      await expectStillRunning(second);
      const secondOpen = page.getByRole("button", { name: `Open approval for ${secondCommand}` });
      await expect(secondOpen).toHaveCount(1);

      await page.getByRole("button", { name: `Allow ${secondCommand}` }).click();
      const secondResult = await second.promise;
      expect(secondResult.code).toBe(0);
      expect(JSON.parse(secondResult.stdout).verdict).toBe("allow");
    } finally {
      second.kill();
    }

    // The originally-listed process is untouched and still waiting.
    await expectStillRunning(first);
    await page.getByRole("button", { name: `Allow ${firstCommand}` }).click();
    const firstResult = await first.promise;
    expect(firstResult.code).toBe(0);
    expect(JSON.parse(firstResult.stdout).verdict).toBe("allow");
  } finally {
    first.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolves the correct process from the expanded view while others stay pending", async ({
  page,
}) => {
  const { dir } = await repoConfig();
  const expandedCommand = uniqueCommand("gh pr merge 42 --squash --delete-branch");
  const pendingCommand = uniqueCommand("rm -rf build");
  const expandedProc = runAllowlister(dir, expandedCommand);
  const pendingProc = runAllowlister(dir, pendingCommand);
  try {
    await expectStillRunning(expandedProc);
    await expectStillRunning(pendingProc);

    await page.goto("/");
    const expandedOpen = page.getByRole("button", { name: `Open approval for ${expandedCommand}` });
    const pendingOpen = page.getByRole("button", { name: `Open approval for ${pendingCommand}` });
    await expect(expandedOpen).toHaveCount(1);
    await expect(pendingOpen).toHaveCount(1);

    // Open one request full-screen and approve it from the detail view.
    await expandedOpen.click();
    await expect(page.getByRole("heading", { name: "Approve shell command" })).toBeVisible();
    await page.getByRole("button", { name: "Allow once" }).click();

    // Only the opened request's plugin resolves.
    const expandedResult = await expandedProc.promise;
    expect(expandedResult.code).toBe(0);
    expect(JSON.parse(expandedResult.stdout).verdict).toBe("allow");

    // Control returns to the inbox with the untouched request still pending and
    // its plugin still blocked.
    await expect(page.getByRole("heading", { name: "Approvals inbox" })).toBeVisible();
    await expect(pendingOpen).toHaveCount(1);
    await expectStillRunning(pendingProc);
  } finally {
    expandedProc.kill();
    pendingProc.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test("approving at the local terminal dismisses the pending web approval", async ({ page }) => {
  test.skip(!ttyApprovalSupported, "local-terminal approval needs a Linux pty");
  const { dir } = await repoConfig();
  const command = uniqueCommand("gh pr merge 42 --squash --delete-branch");
  const running = runAllowlisterWithTty(dir, command);
  try {
    // The local prompt and the web approval appear (almost) simultaneously.
    await running.waitForPrompt();
    expect(running.output()).toContain("[a]llow / [d]eny");
    await page.goto("/");
    const open = page.getByRole("button", { name: `Open approval for ${command}` });
    await expect(open).toHaveCount(1);

    // Deciding at the terminal resolves allowlister and clears the web prompt
    // without anyone touching the browser.
    running.type("a\n");

    const result = await running.promise;
    expect(result.code).toBe(0);
    expect(result.verdict).toBe("allow");
    await expect(open).toHaveCount(0);
  } finally {
    running.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test("denying at the local terminal returns a deny verdict", async () => {
  test.skip(!ttyApprovalSupported, "local-terminal approval needs a Linux pty");
  const { dir } = await repoConfig();
  const command = uniqueCommand("gh pr merge 42 --squash --delete-branch");
  const running = runAllowlisterWithTty(dir, command);
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
  const command = uniqueCommand("gh pr merge 42 --squash --delete-branch");
  const running = runAllowlisterWithTty(dir, command);
  try {
    await running.waitForPrompt();
    await page.goto("/");
    const open = page.getByRole("button", { name: `Open approval for ${command}` });
    await expect(open).toHaveCount(1);

    // Decide remotely from the inbox; the terminal prompt is dismissed without
    // local input.
    await page.getByRole("button", { name: `Allow ${command}` }).click();

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
  const command = uniqueCommand("gh pr merge 42 --squash --delete-branch");
  const running = runAllowlisterWithTty(dir, command);
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
