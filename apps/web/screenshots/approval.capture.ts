import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

// screencomp captures live at <SHOTS_OUT>/<project>/<name>.png. The visual-docs
// workflow and the pre-push hook set SHOTS_OUT per arch lane (shots/current/<arch>);
// when unset (a local `just capture`) we default to that same arch subtree so the
// layout matches what screencomp expects with [capture].arches configured. Resolve
// against the repo root (three levels up) so output is identical regardless of the
// directory the capture is launched from.
const HOST_ARCH: Record<string, string> = { x64: "x86_64", arm64: "arm64" };
const arch = HOST_ARCH[process.arch] ?? process.arch;
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const shotsOut = process.env.SHOTS_OUT ?? `shots/current/${arch}`;
const outRoot = isAbsolute(shotsOut) ? shotsOut : resolve(repoRoot, shotsOut);

// A fixed instant so the demo's live countdown timer and time-derived fixtures
// render identical bytes on every run — screencomp's reproducibility gate
// compares bytes, not pixels.
const FIXED_TIME = new Date("2024-01-01T00:00:00Z");

// Freeze every transition/animation and hide the caret so nothing is captured
// mid-tween (Playwright's animations:"disabled" only covers CSS animations).
const FREEZE_MOTION =
  "*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }";

async function shoot(page: Page, project: string, name: string): Promise<void> {
  const file = resolve(outRoot, project, `${name}.png`);
  await mkdir(dirname(file), { recursive: true });
  await page.addStyleTag({ content: FREEZE_MOTION });
  // Settle before capturing: wait for webfonts and let layout/raster flush over
  // two animation frames, so nothing is caught mid-paint (the cause of otherwise
  // byte-level run-to-run drift, especially on the high-DPI mobile viewport).
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((done) =>
      requestAnimationFrame(() => requestAnimationFrame(() => done())),
    );
  });
  await page.screenshot({ path: file, fullPage: true, animations: "disabled", caret: "hide" });
}

test.beforeEach(async ({ page }) => {
  // Pin the clock before navigation so the fixtures' Date.now() (which sets each
  // request's expiry) and the per-second timers both resolve to FIXED_TIME.
  await page.clock.setFixedTime(FIXED_TIME);
  await page.goto("/?demo=1");
  await expect(page.getByRole("heading", { name: "Approvals inbox" })).toBeVisible();
});

test("inbox", async ({ page }, testInfo) => {
  // The default inbox view: shell and tool requests as triage cards.
  await expect(page.getByRole("list", { name: "Pending approvals" })).toBeVisible();
  await shoot(page, testInfo.project.name, "inbox");
});

test("shell-oneoff", async ({ page }, testInfo) => {
  // A single one-off command that allowlister deferred to remote approval.
  await page
    .getByRole("button", { name: "Open approval for gh pr merge 42 --squash --delete-branch" })
    .click();
  await expect(page.getByRole("heading", { name: /Approve the action/ })).toBeVisible();
  await shoot(page, testInfo.project.name, "shell-oneoff");
});

test("shell-script", async ({ page }, testInfo) => {
  // A longer release script where only two of eight fragments (`npm publish`
  // and `git push`) tripped the gate; the full script is disclosed. Open the
  // disclosure by setting the attribute directly rather than clicking, so no
  // interaction-driven scroll/animation varies bytes.
  await page.getByRole("button", { name: "Open approval for npm publish --access public" }).click();
  await expect(page.getByRole("heading", { name: /Approve the action/ })).toBeVisible();
  await page.locator("details").evaluate((el) => {
    (el as HTMLDetailsElement).open = true;
  });
  await expect(page.getByLabel("Flagged commands")).toContainText("git push origin main --tags");
  await shoot(page, testInfo.project.name, "shell-script");
});

test("tool-formatted", async ({ page }, testInfo) => {
  // A non-shell tool call rendered in the formatted view (canonical params +
  // raw input).
  await page.getByRole("button", { name: "Open approval for mcp__github__create_issue" }).click();
  await expect(page.getByRole("heading", { name: "Approve this tool call" })).toBeVisible();
  await expect(page.getByLabel("Tool call formatted view")).toBeVisible();
  await shoot(page, testInfo.project.name, "tool-formatted");
});

test("tool-json", async ({ page }, testInfo) => {
  // The same tool call rendered as the verbatim protocol-v2 JSON.
  await page.getByRole("button", { name: "Open approval for mcp__github__create_issue" }).click();
  await expect(page.getByRole("heading", { name: "Approve this tool call" })).toBeVisible();
  await page.getByRole("button", { name: "JSON" }).click();
  await expect(page.getByLabel("Tool call JSON view")).toBeVisible();
  await shoot(page, testInfo.project.name, "tool-json");
});

test("tool-capability", async ({ page }, testInfo) => {
  // A capability tool call (a file write) rather than an MCP tool, in the
  // formatted view — its canonical `path` param and verbatim raw input.
  await page.getByRole("button", { name: "Open approval for write" }).click();
  await expect(page.getByRole("heading", { name: "Approve this tool call" })).toBeVisible();
  await expect(page.getByLabel("Tool call formatted view")).toBeVisible();
  await shoot(page, testInfo.project.name, "tool-capability");
});

test("empty-state", async ({ page }, testInfo) => {
  // The inbox after every pending request has been decided.
  for (const name of [
    "Deny gh pr merge 42 --squash --delete-branch",
    "Deny npm publish --access public",
    "Deny mcp__github__create_issue",
    "Deny write",
  ]) {
    await page.getByRole("button", { name }).click();
  }
  await expect(page.getByRole("heading", { name: "No pending approvals" })).toBeVisible();
  await shoot(page, testInfo.project.name, "empty-state");
});
