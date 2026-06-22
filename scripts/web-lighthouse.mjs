#!/usr/bin/env node

// Lighthouse runtime performance audit for the built PWA.
//
// The web app's analogue of the plugin's hyperfine end-to-end CLI latency
// (scripts/bench.sh): it measures the real thing a user waits on — a cold page
// load of the production build in a headless browser — rather than the in-process
// pure functions the Vitest benches isolate. Like the hyperfine numbers, these
// are wall-clock and noisy on shared CI runners, so the report treats them as
// informational; the deterministic, trustworthy delta is the bundle-size layer.
//
// It builds nothing: it serves the existing `apps/web/.next` with `next start`,
// runs Lighthouse against the app shell (no broker is configured, so the inbox
// renders its resting state), then reports the Performance score and the core
// Web Vitals.
//
// Usage: scripts/web-lighthouse.mjs
//
// Results: markdown table on stdout plus machine-readable exports under
// ${LH_OUT:-target/web-perf} (lighthouse.json, lighthouse.md).
//
// Environment overrides:
//   LH_OUT       output directory (default: <repo>/target/web-perf)
//   LH_PORT      port to serve the app on (default: 4184)
//   CHROME_PATH  Chrome/Chromium binary chrome-launcher should drive (it
//                auto-detects an installed Chrome when unset).

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as chromeLauncher from "chrome-launcher";
import lighthouse from "lighthouse";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = process.env.LH_OUT ?? join(repoRoot, "target/web-perf");
const port = Number(process.env.LH_PORT ?? 4184);
const base = `http://127.0.0.1:${port}`;

// No broker is configured here, so the app renders its shell/resting state; the
// audit measures that real app shell.
const route = { name: "app shell", url: `${base}/` };

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`server at ${url} did not become ready within ${timeoutMs}ms`);
}

const server = spawn(
  "npx",
  ["next", "start", "apps/web", "--hostname", "127.0.0.1", "--port", String(port)],
  { cwd: repoRoot, stdio: ["ignore", "ignore", "inherit"] },
);
const stopServer = () => {
  if (!server.killed) server.kill("SIGTERM");
};
process.on("exit", stopServer);

let chrome;
try {
  await waitForServer(base);

  chrome = await chromeLauncher.launch({
    chromeFlags: ["--headless=new", "--no-sandbox", "--disable-gpu"],
  });

  const runnerResult = await lighthouse(
    route.url,
    { port: chrome.port, output: "json", logLevel: "error", onlyCategories: ["performance"] },
    // A desktop form factor mirrors the primary approval surface; throttling is
    // Lighthouse's simulated default so the metrics reflect a typical client.
    {
      extends: "lighthouse:default",
      settings: { formFactor: "desktop", screenEmulation: { disabled: true } },
    },
  );
  if (!runnerResult?.lhr) fail("Lighthouse returned no result");
  const { lhr } = runnerResult;

  const score = Math.round((lhr.categories.performance.score ?? 0) * 100);
  // The core Web Vitals plus the two supporting timings Lighthouse weights most.
  const metricIds = [
    ["first-contentful-paint", "First Contentful Paint"],
    ["largest-contentful-paint", "Largest Contentful Paint"],
    ["total-blocking-time", "Total Blocking Time"],
    ["cumulative-layout-shift", "Cumulative Layout Shift"],
    ["speed-index", "Speed Index"],
    ["interactive", "Time to Interactive"],
  ];
  const metrics = metricIds.map(([id, label]) => ({
    id,
    label,
    display: lhr.audits[id]?.displayValue ?? "—",
    value: lhr.audits[id]?.numericValue ?? null,
  }));

  const md = [
    `**Performance score: ${score} / 100** — \`${route.name}\``,
    "",
    "| metric | value |",
    "|---|---:|",
    ...metrics.map((m) => `| ${m.label} | ${m.display} |`),
  ].join("\n");

  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "lighthouse.md"), `${md}\n`);
  writeFileSync(
    join(out, "lighthouse.json"),
    `${JSON.stringify({ route: route.name, url: route.url, score, metrics }, null, 2)}\n`,
  );

  console.log(md);
  console.log(`\n✓ wrote ${join(out, "lighthouse.json")}`);
  console.log(`       ${join(out, "lighthouse.md")}`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  if (chrome) await chrome.kill();
  stopServer();
}
