import { expect, test } from "@playwright/test";

test("lists concurrent requests in the inbox and approves one from the list", async ({ page }) => {
  await page.goto("/?demo=1");

  await expect(page.getByRole("heading", { name: "Approvals inbox" })).toBeVisible();
  const list = page.getByRole("list", { name: "Pending approvals" });
  await expect(list.getByText("gh pr merge 42 --squash --delete-branch")).toBeVisible();
  await expect(list.getByText("rm -rf dist")).toBeVisible();

  await page.getByRole("button", { name: "Allow gh pr merge 42 --squash --delete-branch" }).click();

  await expect(list.getByText("gh pr merge 42 --squash --delete-branch")).toHaveCount(0);
  await expect(list.getByText("rm -rf dist")).toBeVisible();
});

test("opens a full-screen expanded approval view from the inbox", async ({ page }) => {
  await page.goto("/?demo=1");

  await page
    .getByRole("button", { name: "Open approval for gh pr merge 42 --squash --delete-branch" })
    .click();

  await expect(page.getByRole("heading", { name: /Approve the action/ })).toBeVisible();
  await expect(page.getByLabel("Important commands")).toContainText(
    "gh pr merge 42 --squash --delete-branch",
  );
  await expect(page.getByLabel("Risk signals")).toContainText("GitHub write");
  await expect(page.getByText("/workspace/acme-api")).toBeVisible();

  await page.getByText("Show full script").click();
  await expect(page.getByText("git diff --stat && npm test && gh pr merge 42")).toBeVisible();

  await page.getByRole("button", { name: /All approvals/ }).click();
  await expect(page.getByRole("heading", { name: "Approvals inbox" })).toBeVisible();
});
