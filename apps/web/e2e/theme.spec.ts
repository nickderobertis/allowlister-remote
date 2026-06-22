import { expect, test } from "@playwright/test";

const html = (page: import("@playwright/test").Page) => page.locator("html");

test("follows the OS colour scheme automatically", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  // No broker is reachable in this spec, so the inbox shows its resting state;
  // that is enough to exercise theming.
  await expect(page.getByRole("heading", { name: "No pending approvals" })).toBeVisible();

  // Default preference is "system", so the app tracks the OS setting live.
  await expect(html(page)).toHaveClass(/dark/);

  await page.emulateMedia({ colorScheme: "light" });
  await expect(html(page)).not.toHaveClass(/dark/);
});

test("pins a theme from the toggle and keeps it across the OS switching", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");

  const toggle = page.getByRole("button", { name: /^Theme:/ });

  // system (dark via OS) → click → light: the pin wins over the OS.
  await expect(html(page)).toHaveClass(/dark/);
  await toggle.click();
  await expect(toggle).toHaveAccessibleName(/Theme: Light/);
  await expect(html(page)).not.toHaveClass(/dark/);

  // The OS flipping must not override an explicit light pin.
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(html(page)).not.toHaveClass(/dark/);

  // light → click → dark.
  await toggle.click();
  await expect(toggle).toHaveAccessibleName(/Theme: Dark/);
  await expect(html(page)).toHaveClass(/dark/);
});
