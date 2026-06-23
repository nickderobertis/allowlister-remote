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
    command: "npx next start --hostname 127.0.0.1 --port 4183",
    url: "http://127.0.0.1:4183",
    reuseExistingServer: false,
    // The broker is the app's only request transport. The broker-realtime spec
    // runs a broker on this fixed port and drives the app through it; /api/config
    // returns the derived /ws/pwa endpoint at runtime. The other specs (offline
    // shell, theme) do not need approval requests, so their service worker simply
    // retries the (down) broker harmlessly in the background while they run.
    env: { ALLOWLISTER_REMOTE_BROKER_URL: "ws://127.0.0.1:4188" },
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
