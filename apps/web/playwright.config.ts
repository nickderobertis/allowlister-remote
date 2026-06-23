import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4183",
    trace: "on-first-retry",
  },
  webServer: {
    // The PWA is a static export (apps/web/out); serve it with the zero-dep
    // static server. cwd defaults to this config's directory (apps/web). The
    // broker URL is no longer a server env — each spec seeds it client-side
    // (localStorage) before navigating, since the broker is the app's only
    // request transport and its URL is now a per-device setting.
    command: "node ../../scripts/serve-web.mjs --dir out --port 4183",
    url: "http://127.0.0.1:4183",
    reuseExistingServer: false,
  },
  projects: [
    {
      name: "chromium-desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1100 },
      },
    },
    {
      name: "mobile-chrome",
      use: { ...devices["Pixel 7"] },
    },
  ],
});
