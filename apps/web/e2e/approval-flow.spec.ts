import { expect, test } from "@playwright/test";

test("prioritizes allowlister fragments and supports a full approval flow", async ({
  page,
}) => {
  await page.goto("/?demo=1");

  await expect(
    page.getByRole("heading", { name: /Approve the action/ }),
  ).toBeVisible();
  await expect(page.getByLabel("Important commands")).toContainText(
    "gh pr merge 42 --squash --delete-branch",
  );
  await expect(page.getByLabel("Risk signals")).toContainText("GitHub write");
  await expect(page.getByText("Parsed allowlister fragments")).toBeVisible();
  await expect(page.getByText("/workspace/acme-api")).toBeVisible();

  await page.getByRole("button", { name: "Allow once" }).click();

  await expect(
    page.getByRole("heading", { name: "No pending approvals" }),
  ).toBeVisible();
});

test("keeps the complete script available but secondary", async ({ page }) => {
  await page.goto("/?demo=1");

  await page.getByText("Show full script").click();

  await expect(
    page.getByText("git diff --stat && npm test && gh pr merge 42"),
  ).toBeVisible();
});
