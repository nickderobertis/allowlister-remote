import { expect, test } from "@playwright/test";

test("lists concurrent requests in the inbox and approves one from the list", async ({ page }) => {
  await page.goto("/?demo=1");

  await expect(page.getByRole("heading", { name: "Approvals inbox" })).toBeVisible();
  const list = page.getByRole("list", { name: "Pending approvals" });
  // Each card previews its flagged script lines directly, so match exactly to pin
  // the command line itself.
  await expect(
    list.getByText("gh pr merge 42 --squash --delete-branch", { exact: true }),
  ).toBeVisible();
  // The longer release script lists each of its flagged fragments inline on the
  // one card, not just the first.
  await expect(list.getByText("npm publish --access public", { exact: true })).toBeVisible();
  await expect(list.getByText("git push origin main --tags", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Allow gh pr merge 42 --squash --delete-branch" }).click();

  await expect(
    list.getByText("gh pr merge 42 --squash --delete-branch", { exact: true }),
  ).toHaveCount(0);
  await expect(list.getByText("npm publish --access public", { exact: true })).toBeVisible();
});

test("opens a shell approval and shows the interactive script", async ({ page }) => {
  await page.goto("/?demo=1");

  await page.getByRole("button", { name: "Open approval for npm publish --access public" }).click();

  await expect(page.getByRole("heading", { name: "Approve shell command" })).toBeVisible();
  // Only the two tripping fragments are surfaced for attention.
  await expect(page.getByLabel("Flagged commands")).toContainText("npm publish --access public");
  await expect(page.getByLabel("Flagged commands")).toContainText("git push origin main --tags");
  await expect(page.getByText("/workspace/acme-api")).toBeVisible();

  // The interactive script lists every fragment in order, statically allowed ones
  // included; clicking a fragment discloses its rule and reason.
  const script = page.getByLabel("Script");
  await expect(script).toContainText("set -euo pipefail");
  await script.getByRole("button", { name: /git push origin main --tags/ }).click();
  await expect(script).toContainText("ask before pushing to a remote");

  await page.getByRole("button", { name: /All approvals/ }).click();
  await expect(page.getByRole("heading", { name: "Approvals inbox" })).toBeVisible();
});

test("opens a tool call and switches between formatted and JSON views", async ({ page }) => {
  await page.goto("/?demo=1");

  await page.getByRole("button", { name: "Open approval for mcp__github__create_issue" }).click();

  await expect(page.getByRole("heading", { name: "Approve this tool call" })).toBeVisible();
  await expect(page.getByLabel("Tool call formatted view")).toContainText("capability: mcp");
  // The formatted view lists the arguments the agent passed...
  await expect(page.getByLabel("Tool call formatted view")).toContainText("Production is down");

  // ...and the JSON view shows just those arguments (the verbatim raw input).
  await page.getByRole("button", { name: "JSON" }).click();
  await expect(page.getByLabel("Tool call JSON view")).toContainText(
    '"title": "Production is down"',
  );
});
