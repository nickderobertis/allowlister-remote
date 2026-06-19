import { expect, test } from "@playwright/test";

test("lists concurrent requests in the inbox and approves one from the list", async ({ page }) => {
  await page.goto("/?demo=1");

  await expect(page.getByRole("heading", { name: "Approvals inbox" })).toBeVisible();
  const list = page.getByRole("list", { name: "Pending approvals" });
  // Match the headline <code> exactly so the substring inside each card's reason
  // line does not also match.
  await expect(
    list.getByText("gh pr merge 42 --squash --delete-branch", { exact: true }),
  ).toBeVisible();
  // The longer release script headlines on its first flagged fragment.
  await expect(list.getByText("npm publish --access public", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Allow gh pr merge 42 --squash --delete-branch" }).click();

  await expect(
    list.getByText("gh pr merge 42 --squash --delete-branch", { exact: true }),
  ).toHaveCount(0);
  await expect(list.getByText("npm publish --access public", { exact: true })).toBeVisible();
});

test("opens a shell approval and discloses the full script", async ({ page }) => {
  await page.goto("/?demo=1");

  await page.getByRole("button", { name: "Open approval for npm publish --access public" }).click();

  await expect(page.getByRole("heading", { name: /Approve the action/ })).toBeVisible();
  // Only the two tripping fragments are surfaced for attention.
  await expect(page.getByLabel("Flagged commands")).toContainText("npm publish --access public");
  await expect(page.getByLabel("Flagged commands")).toContainText("git push origin main --tags");
  await expect(page.getByText("/workspace/acme-api")).toBeVisible();

  await page.getByText("Show full script").click();
  // The full script is the only <pre>; its fragments also appear as <code> rows.
  await expect(page.locator("pre")).toContainText("set -euo pipefail");

  await page.getByRole("button", { name: /All approvals/ }).click();
  await expect(page.getByRole("heading", { name: "Approvals inbox" })).toBeVisible();
});

test("opens a tool call and switches between formatted and JSON views", async ({ page }) => {
  await page.goto("/?demo=1");

  await page.getByRole("button", { name: "Open approval for mcp__github__create_issue" }).click();

  await expect(page.getByRole("heading", { name: "Approve this tool call" })).toBeVisible();
  await expect(page.getByLabel("Tool call formatted view")).toContainText("capability: mcp");

  await page.getByRole("button", { name: "JSON" }).click();
  await expect(page.getByLabel("Tool call JSON view")).toContainText(
    '"name": "mcp__github__create_issue"',
  );
});
