import { spawn } from "node:child_process";
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

test("allowlister waits for a remote allow decision from the expanded view", async ({ page }) => {
  const { dir } = await repoConfig();
  const running = runAllowlister(dir, "gh pr merge 42 --squash --delete-branch");
  try {
    await expectStillRunning(running);
    await page.goto("/");
    await page
      .getByRole("button", { name: "Open approval for gh pr merge 42 --squash --delete-branch" })
      .click();
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
  const running = runAllowlister(dir, "gh pr merge 42 --squash --delete-branch");
  try {
    await expectStillRunning(running);
    await page.goto("/");
    await page
      .getByRole("button", { name: "Deny gh pr merge 42 --squash --delete-branch" })
      .click();

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
  const allowProc = runAllowlister(dir, "gh pr merge 42 --squash --delete-branch");
  const denyProc = runAllowlister(dir, "rm -rf build");
  try {
    // Both plugin processes block waiting on the same remote app concurrently.
    await expectStillRunning(allowProc);
    await expectStillRunning(denyProc);

    await page.goto("/");
    const list = page.getByRole("list", { name: "Pending approvals" });
    await expect(list.getByRole("listitem")).toHaveCount(2);
    await expect(list.getByText("gh pr merge 42 --squash --delete-branch")).toBeVisible();
    await expect(list.getByText("rm -rf build")).toBeVisible();

    // Deny one request from the list; the other must stay pending.
    await page.getByRole("button", { name: "Deny rm -rf build" }).click();
    await expect(list.getByText("rm -rf build")).toHaveCount(0);
    await expect(list.getByText("gh pr merge 42 --squash --delete-branch")).toBeVisible();

    const denyResult = await denyProc.promise;
    expect(denyResult.code).toBe(2);
    expect(JSON.parse(denyResult.stdout).verdict).toBe("deny");

    // The remaining process is still blocked until its own decision arrives.
    await expectStillRunning(allowProc);
    await page
      .getByRole("button", { name: "Allow gh pr merge 42 --squash --delete-branch" })
      .click();

    const allowResult = await allowProc.promise;
    expect(allowResult.code).toBe(0);
    expect(JSON.parse(allowResult.stdout).verdict).toBe("allow");

    await expect(page.getByRole("heading", { name: "No pending approvals" })).toBeVisible();
  } finally {
    allowProc.kill();
    denyProc.kill();
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
