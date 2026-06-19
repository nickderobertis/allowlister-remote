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
  // The default inbox view: every pending request as a triage card.
  await expect(page.getByRole("list", { name: "Pending approvals" })).toBeVisible();
  await shoot(page, testInfo.project.name, "inbox");
});

test("detail", async ({ page }, testInfo) => {
  // Expand the first request into the full-screen approval view, with the full
  // script disclosed. Open the disclosure by setting the attribute directly
  // rather than clicking, so no interaction-driven scroll/animation varies bytes.
  await page
    .getByRole("button", { name: "Open approval for gh pr merge 42 --squash --delete-branch" })
    .click();
  await expect(page.getByRole("heading", { name: /Approve the action/ })).toBeVisible();
  await page.locator("details").evaluate((el) => {
    (el as HTMLDetailsElement).open = true;
  });
  await expect(page.getByText("git diff --stat && npm test && gh pr merge 42")).toBeVisible();
  await shoot(page, testInfo.project.name, "detail");
});
