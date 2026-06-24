import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  // Hard cap on the whole run as a backstop: the realtime spec drives real
  // broker/daemon/plugin processes and a static webServer, so a wedged hook or
  // teardown (rather than a single test, which the per-test timeout already
  // bounds) could otherwise ride the CI job to its 30-minute cap. The suite
  // finishes in a few minutes; 10 fails fast while leaving generous headroom.
  globalTimeout: 600_000,
  workers: 1,
  // Retry in CI: the realtime specs drive real broker/daemon/plugin processes and
  // a browser, so request delivery can occasionally exceed a step timeout under
  // shared-runner load. Retries keep that flake from failing the whole matrix;
  // `trace: "on-first-retry"` captures a trace when one happens.
  retries: process.env.CI ? 2 : 0,
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
