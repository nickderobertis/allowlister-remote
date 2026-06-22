import { expect, type Page, test } from "@playwright/test";
import { recordShot } from "./capture-index";

// A fixed instant pinned defensively so nothing time-derived can drift bytes
// between runs — screencomp's reproducibility gate compares bytes, not pixels.
const FIXED_TIME = new Date("2024-01-01T00:00:00Z");

// Freeze every transition/animation and hide the caret so nothing is captured
// mid-tween (Playwright's animations:"disabled" only covers CSS animations).
const FREEZE_MOTION =
  "*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }";

// position:fixed chrome (the floating "Shortcuts" hint and the theme toggle)
// paints relative to the viewport, which races Playwright's beyond-viewport
// fullPage capture on any page taller than the viewport (today only
// desktop/shell-script, where the disclosed script overflows): the chrome lands
// at the viewport edge in one run and the document edge in the next, drifting
// bytes run-to-run. Re-anchor every fixed element to the document (during capture
// the only fixed elements are the theme toggle and, on desktop, the floating
// hint; the shortcuts overlay is never open) so each paints at one deterministic
// spot every run. body becomes the containing block; nothing else is absolutely
// positioned, so this moves only that chrome.
const PIN_FIXED_CHROME =
  "body { position: relative !important; } .fixed { position: absolute !important; }";

// The app follows prefers-color-scheme automatically, so capturing both themes is
// just a matter of emulating the OS setting and letting the ThemeProvider react.
const THEMES = ["dark", "light"] as const;

async function shoot(page: Page, viewport: string, name: string): Promise<void> {
  await page.addStyleTag({ content: `${FREEZE_MOTION}\n${PIN_FIXED_CHROME}` });
  for (const theme of THEMES) {
    await page.emulateMedia({ colorScheme: theme });
    // Wait until the ThemeProvider has mirrored the emulated scheme onto <html>,
    // so the screenshot never races the class flip.
    await page.waitForFunction(
      (expected) => document.documentElement.classList.contains("dark") === (expected === "dark"),
      theme,
    );
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
    // Each viewport/theme pair is a toggle combination on the same shot name;
    // recordShot writes the PNG and upserts the entry into this lane's index.
    await recordShot(name, { viewport, theme }, png);
  }
}

test.beforeEach(async ({ page }) => {
  // Pin the clock before navigation so anything time-derived resolves to a
  // stable FIXED_TIME instead of the wall clock.
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
  await expect(page.getByRole("heading", { name: "Approve shell command" })).toBeVisible();
  await shoot(page, testInfo.project.name, "shell-oneoff");
});

test("shell-script", async ({ page }, testInfo) => {
  // A longer build-and-deploy script where two fragments tripped the gate — the
  // `kubectl apply` nested in the `for` loop body and the standalone `git push`;
  // the interactive script renders the real script line by line (loop structure
  // intact), colored by permission. Captured in its default (no fragment expanded)
  // state so no interaction-driven scroll varies bytes.
  await page
    .getByRole("button", {
      name: "Open approval for kubectl --context $region apply -f deploy/manifest.yaml",
    })
    .click();
  await expect(page.getByRole("heading", { name: "Approve shell command" })).toBeVisible();
  await expect(page.getByLabel("Script")).toContainText(
    "for region in $(cat deploy/regions.txt); do",
  );
  await expect(page.getByLabel("Flagged commands")).toContainText("git push origin main --tags");
  await shoot(page, testInfo.project.name, "shell-script");
});

test("tool-formatted", async ({ page }, testInfo) => {
  // A non-shell tool call rendered in the formatted view (its arguments).
  await page.getByRole("button", { name: "Open approval for mcp__github__create_issue" }).click();
  await expect(page.getByRole("heading", { name: "Approve this tool call" })).toBeVisible();
  await expect(page.getByLabel("Tool call formatted view")).toBeVisible();
  await shoot(page, testInfo.project.name, "tool-formatted");
});

test("tool-json", async ({ page }, testInfo) => {
  // The same tool call's arguments rendered as verbatim JSON.
  await page.getByRole("button", { name: "Open approval for mcp__github__create_issue" }).click();
  await expect(page.getByRole("heading", { name: "Approve this tool call" })).toBeVisible();
  await page.getByRole("button", { name: "JSON" }).click();
  await expect(page.getByLabel("Tool call JSON view")).toBeVisible();
  await shoot(page, testInfo.project.name, "tool-json");
});

test("tool-capability", async ({ page }, testInfo) => {
  // A capability tool call (a file write) rather than an MCP tool, in the
  // formatted view — its `path` argument.
  await page.getByRole("button", { name: "Open approval for write" }).click();
  await expect(page.getByRole("heading", { name: "Approve this tool call" })).toBeVisible();
  await expect(page.getByLabel("Tool call formatted view")).toBeVisible();
  await shoot(page, testInfo.project.name, "tool-capability");
});

test("empty-state", async ({ page }, testInfo) => {
  // The inbox after every pending request has been decided.
  for (const name of [
    "Deny gh pr merge 42 --squash --delete-branch",
    "Deny kubectl --context $region apply -f deploy/manifest.yaml",
    "Deny mcp__github__create_issue",
    "Deny write",
  ]) {
    await page.getByRole("button", { name }).click();
  }
  await expect(page.getByRole("heading", { name: "No pending approvals" })).toBeVisible();
  await shoot(page, testInfo.project.name, "empty-state");
});
