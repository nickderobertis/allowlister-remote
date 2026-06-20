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
//
// We deliberately drop the README's --use-gl=angle / --use-angle=swiftshader
// and instead force every pixel — raster AND compositing — through CPU Skia.
// SwiftShader is a software GL renderer, but it dispatches on CPU SIMD and is
// not bit-identical across microarchitectures; --disable-skia-runtime-opts (the
// README's "decisive" CPU-independence flag) governs Skia, NOT SwiftShader. So
// routing compositing through SwiftShader reintroduced CPU-dependent bytes on
// the densest, most-blended shot (tool-json desktop), making the strict gate
// flaky across ubuntu-latest's heterogeneous runners (same commit, re-run flips
// pass/fail). screencomp's own README confirms the CPU-raster path
// (--disable-gpu + --disable-skia-runtime-opts, no SwiftShader) stays
// byte-identical to CI; --disable-gpu-compositing keeps the compositor on Skia
// too so nothing falls back to a GL context.
//
// Dropping SwiftShader was necessary but not sufficient: the dense tool-json
// shot still drifted by 9 px / 1 LSB between an Intel baseline and an AMD EPYC
// runner. Text layout in Blink is computed in floating point, and Intel vs AMD
// disagree in the last bit (FMA contraction / rounding), nudging a glyph's pen
// position across a pixel boundary. The densest shot has the most glyphs, so it
// is the one that trips it; no Chromium/fontconfig flag fixes float layout
// (full hinting AND disabling anti-aliasing were both tried and still drifted on
// AMD). The tell is in the matrix itself: tool-json [mobile] never drifts, only
// tool-json [desktop] — and the only difference is deviceScaleFactor. Mobile
// captures at the Pixel 7's 2.625x, desktop at 1x. So we render desktop at
// deviceScaleFactor 2 below (see the project): supersampling absorbs the
// sub-pixel float jitter the same way it already does on the mobile lane, which
// keeps crisp anti-aliased text and a hard, CPU-stable byte gate. Font hinting
// is left at the container default; no fontconfig override is needed.
const DETERMINISM_ARGS = [
  "--disable-skia-runtime-opts",
  "--disable-gpu",
  "--disable-gpu-rasterization",
  "--disable-gpu-compositing",
  "--force-color-profile=srgb",
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
        // Capture at 2x. Desktop Chrome defaults to deviceScaleFactor 1, where
        // the dense tool-json shot drifts across CPU microarchitectures; the
        // mobile lane (Pixel 7, 2.625x) never does. Supersampling absorbs the
        // sub-pixel floating-point jitter in Blink's glyph positioning, so the
        // byte gate stays CPU-stable while keeping anti-aliased text.
        deviceScaleFactor: 2,
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
