import { expect, type Page, test } from "@playwright/test";
import { recordShot } from "./capture-index";

// A fixed instant so the demo's live countdown timer and time-derived fixtures
// render identical bytes on every run — screencomp's reproducibility gate
// compares bytes, not pixels.
const FIXED_TIME = new Date("2024-01-01T00:00:00Z");

// Freeze every transition/animation and hide the caret so nothing is captured
// mid-tween (Playwright's animations:"disabled" only covers CSS animations).
const FREEZE_MOTION =
  "*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }";

// position:fixed chrome (the floating "Shortcuts" hint) paints relative to the
// viewport, which races Playwright's beyond-viewport fullPage capture on any page
// taller than the viewport (today only desktop/shell-script, where the disclosed
// script overflows): the hint lands at the viewport bottom in one run and the
// document bottom in the next, drifting bytes run-to-run. Re-anchor that chrome to
// the document (the only fixed element in a captured state is the floating hint;
// the shortcuts overlay is never open during capture) so it paints at one
// deterministic spot every run. body becomes the containing block; nothing else is
// absolutely positioned, so this moves only the hint.
const PIN_FIXED_CHROME =
  "body { position: relative !important; } .fixed { position: absolute !important; }";

async function shoot(page: Page, viewport: string, name: string): Promise<void> {
  await page.addStyleTag({ content: `${FREEZE_MOTION}\n${PIN_FIXED_CHROME}` });
  // Settle before capturing: wait for webfonts and let layout/raster flush over
  // two animation frames, so nothing is caught mid-paint (the cause of otherwise
  // byte-level run-to-run drift, especially on the high-DPI mobile viewport).
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((done) =>
      requestAnimationFrame(() => requestAnimationFrame(() => done())),
    );
  });
  const png = await page.screenshot({ fullPage: true, animations: "disabled", caret: "hide" });
  // Each viewport is a `viewport` toggle on the same shot name; recordShot writes
  // the PNG and upserts the entry into this lane's captures.json index.
  await recordShot(name, { viewport }, png);
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
