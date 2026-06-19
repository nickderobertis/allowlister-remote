import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";

const root = resolve(import.meta.dirname, "../../..");
const plugin = join(root, "target", "debug", "allowlister-remote-plugin");
const serverUrl = "http://127.0.0.1:4183";

type Running = {
  promise: Promise<{ code: number | null; stdout: string; stderr: string }>;
  kill(): void;
};

async function repoConfig(extraRules = "") {
  const dir = await mkdtemp(join(tmpdir(), "allowlister-remote-e2e-"));
  const config = `{
    "rules": [${extraRules}],
    "plugins": [{
      "name": "allowlister remote",
      "command": ["${plugin}", "--server-url", "${serverUrl}", "--timeout-ms", "30000", "--poll-ms", "100"],
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

// The Next.js server keeps approval requests in a process-wide in-memory store
// that lives for the whole Playwright run, so every test must use a unique
// command. That way each test only ever matches its own request and is immune
// to undecided requests left behind by other tests (or the desktop/mobile
// projects sharing the same server).
function uniqueCommand(base: string) {
  return `${base} ${randomUUID().slice(0, 8)}`;
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
    await expect(page.getByRole("heading", { name: /Approve the action/ })).toBeVisible();
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
