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
    command:
      "node ./bin/allowlister-remote.mjs serve --app-dir dist --state-dir .e2e-state --host 127.0.0.1 --port 4183",
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
