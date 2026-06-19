import { defineConfig, devices } from "@playwright/test";

// Deterministic screenshot capture for screencomp's visual-docs gate. This is
// intentionally separate from the functional e2e config (playwright.config.ts):
// it renders byte-reproducible PNGs plus a captures.json index into SHOTS_OUT,
// which screencomp then classifies, galleries, and comments on.
//
// The Chromium flags below are the *determinism* set from the screencomp README
// ("Split the Chromium flags"): they pin the render path so the same build
// produces identical bytes on every machine. Stability flags (e.g.
// --single-process) are deliberately omitted — they are unsafe for an
// interactive SPA and change no bytes.
const DETERMINISM_ARGS = [
  "--disable-skia-runtime-opts",
  "--disable-gpu",
  "--disable-gpu-rasterization",
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--force-color-profile=srgb",
  "--font-render-hinting=none",
  "--disable-lcd-text",
  "--hide-scrollbars",
];

// A dedicated port so a capture run never collides with the e2e server (4183).
const PORT = 4184;

export default defineConfig({
  testDir: "./screenshots",
  testMatch: "**/*.capture.ts",
  // Reset the capture root and seed an empty captures.json before any shots run.
  globalSetup: "./screenshots/global-setup.ts",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // One browser process per viewport, single worker: reliable and still
  // byte-reproducible (bytes do not depend on process lifetime).
  workers: 1,
  retries: 0,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    // Block the PWA service worker during capture. Its async register/install/
    // activate races with the screenshot (worst on the slow high-DPI mobile
    // lane) and is irrelevant to the rendered UI, so it caused run-to-run byte
    // drift on shots/<mobile>/detail. Blocking it keeps captures deterministic.
    serviceWorkers: "block",
  },
  webServer: {
    // Serves the production build from apps/web/.next (run `next build` first;
    // the Nx `capture` target wires that as a dependency). cwd defaults to this
    // config's directory (apps/web).
    command: `npx next start --hostname 127.0.0.1 --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1100 },
        launchOptions: { args: DETERMINISM_ARGS },
      },
    },
    {
      name: "mobile",
      use: {
        ...devices["Pixel 7"],
        launchOptions: { args: DETERMINISM_ARGS },
      },
    },
  ],
});
