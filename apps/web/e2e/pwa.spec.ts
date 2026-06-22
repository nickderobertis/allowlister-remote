import { expect, test } from "@playwright/test";

test("serves a valid manifest and PWA icon assets", async ({ request }) => {
  const manifestResponse = await request.get("/manifest.webmanifest");
  expect(manifestResponse.ok()).toBe(true);

  const manifest = await manifestResponse.json();
  expect(manifest.display).toBe("standalone");
  expect(manifest.start_url).toBe("/");

  const iconSources: string[] = manifest.icons.map((icon: { src: string }) => icon.src);
  for (const src of [...iconSources, "/apple-touch-icon.png"]) {
    const asset = await request.get(src);
    expect(asset.ok(), `expected ${src} to be served`).toBe(true);
  }
});

test("serves a registerable service worker", async ({ request }) => {
  const response = await request.get("/sw.js");
  expect(response.ok()).toBe(true);
  expect(response.headers()["content-type"]).toContain("javascript");
});

test("registers a service worker that controls the page", async ({ page }) => {
  await page.goto("/");

  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });

  // After the worker activates it should control a reloaded page.
  await page.reload();
  const controlled = await page.evaluate(() => navigator.serviceWorker.controller !== null);
  expect(controlled).toBe(true);
});

test("renders the app shell while offline", async ({ page, context }) => {
  await page.goto("/");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  // Prime the navigation cache.
  await page.reload();

  await context.setOffline(true);
  try {
    await page.reload();
    await expect(page.locator("body")).not.toBeEmpty();
  } finally {
    await context.setOffline(false);
  }
});
