#!/usr/bin/env node

// Deterministic client bundle-size report for the Next.js PWA.
//
// This is the web app's analogue of the plugin's cachegrind instruction counts
// (scripts/bench-instructions.sh): a measurement that is reproducible for a
// given build, so a base-vs-PR delta is trustworthy where a wall-clock or
// Lighthouse number is noisy. It weighs exactly what ships to the browser — the
// client JS and CSS under `.next/static` — gzipped (the size that crosses the
// wire) and raw.
//
// Turbopack content-hashes every chunk filename, so per-file names are not
// comparable across builds; this report aggregates by *category* (app shell,
// polyfills, CSS, total) whose names are stable, and those are what the delta
// table diffs. The build manifest names the shell/polyfill chunks every page
// loads, so "first-load JS" — shell + polyfills — is the headline metric.
//
// Usage:
//   scripts/web-bundle-size.mjs [appDir]            Measure (default: apps/web).
//   scripts/web-bundle-size.mjs report BASE HEAD    Markdown delta table from two
//                                                   bundle-size.tsv files.
//
// Results: markdown table on stdout plus machine-readable exports under
// ${BUNDLE_OUT:-target/web-perf} (bundle-size.json, bundle-size.tsv,
// bundle-size.md).
//
// Environment overrides:
//   BUNDLE_OUT   output directory (default: <repo>/target/web-perf)

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function fmtBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} kB`;
}

// `report` joins a base and a head TSV (category<TAB>gzip<TAB>raw) into a
// markdown delta table. It touches no build output, so CI can run it after
// checking back out of the base revision.
function reportDelta(baseTsv, headTsv) {
  const parse = (path) => {
    const rows = new Map();
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const [name, gzip, raw] = line.split("\t");
      rows.set(name, { gzip: Number(gzip), raw: Number(raw) });
    }
    return rows;
  };
  const base = parse(baseTsv);
  const head = parse(headTsv);

  const lines = ["| category | base (gzip) | head (gzip) | Δ gzip |", "|---|---:|---:|---:|"];
  for (const [name, { gzip, raw }] of head) {
    const prior = base.get(name);
    if (prior && prior.gzip > 0) {
      const delta = ((gzip - prior.gzip) / prior.gzip) * 100;
      const sign = delta >= 0 ? "+" : "";
      lines.push(
        `| ${name} | ${fmtBytes(prior.gzip)} | ${fmtBytes(gzip)} | ${sign}${delta.toFixed(2)}% |`,
      );
    } else {
      lines.push(`| ${name} | — | ${fmtBytes(gzip)} (${fmtBytes(raw)} raw) | new |`);
    }
  }
  return lines.join("\n");
}

if (process.argv[2] === "report") {
  const [, , , baseTsv, headTsv] = process.argv;
  if (!baseTsv || !headTsv) {
    fail("usage: web-bundle-size.mjs report BASE.tsv HEAD.tsv");
  }
  console.log(reportDelta(baseTsv, headTsv));
  process.exit(0);
}

const appDir = join(repoRoot, process.argv[2] ?? "apps/web");
const nextDir = join(appDir, ".next");
const staticDir = join(nextDir, "static");

let manifest;
try {
  manifest = JSON.parse(readFileSync(join(nextDir, "build-manifest.json"), "utf8"));
} catch {
  fail(
    `no build manifest at ${join(nextDir, "build-manifest.json")} — run \`nx run web:build\` first.`,
  );
}

// Walk every file under .next/static, recording each JS/CSS asset's gzipped and
// raw size, keyed by its path relative to .next (matching the manifest's form).
const assets = new Map();
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(abs);
      continue;
    }
    if (!/\.(js|css)$/.test(entry.name)) continue;
    const buf = readFileSync(abs);
    assets.set(relative(nextDir, abs), {
      gzip: gzipSync(buf, { level: 9 }).length,
      raw: statSync(abs).size,
    });
  }
}
walk(staticDir);

const sum = (paths) => {
  let gzip = 0;
  let raw = 0;
  for (const path of paths) {
    const asset = assets.get(path);
    if (asset) {
      gzip += asset.gzip;
      raw += asset.raw;
    }
  }
  return { gzip, raw };
};

const shellFiles = manifest.rootMainFiles ?? [];
const polyfillFiles = manifest.polyfillFiles ?? [];
const jsAssets = [...assets].filter(([path]) => path.endsWith(".js"));
const cssAssets = [...assets].filter(([path]) => path.endsWith(".css"));

// Stable, build-agnostic category names: the delta table diffs these, never the
// content-hashed filenames Turbopack regenerates each build.
const categories = {
  "app shell (rootMainFiles)": sum(shellFiles),
  polyfills: sum(polyfillFiles),
  "first-load JS (shell + polyfills)": sum([...shellFiles, ...polyfillFiles]),
  "all client JS": sum(jsAssets.map(([path]) => path)),
  "all client CSS": sum(cssAssets.map(([path]) => path)),
};

const topChunks = jsAssets
  .map(([path, asset]) => ({ path, ...asset }))
  .sort((a, b) => b.gzip - a.gzip)
  .slice(0, 5);

const out = process.env.BUNDLE_OUT ?? join(repoRoot, "target/web-perf");
mkdirSync(out, { recursive: true });

const summaryLines = [
  "| category | gzip | raw |",
  "|---|---:|---:|",
  ...Object.entries(categories).map(
    ([name, { gzip, raw }]) => `| ${name} | ${fmtBytes(gzip)} | ${fmtBytes(raw)} |`,
  ),
];
const topLines = [
  "",
  "Largest client JS chunks (gzip):",
  "",
  "| chunk | gzip | raw |",
  "|---|---:|---:|",
  ...topChunks.map(
    (c) =>
      `| \`${c.path.replace(/^static\/chunks\//, "")}\` | ${fmtBytes(c.gzip)} | ${fmtBytes(c.raw)} |`,
  ),
];
const md = [...summaryLines, ...topLines].join("\n");

writeFileSync(join(out, "bundle-size.md"), `${md}\n`);
writeFileSync(
  join(out, "bundle-size.json"),
  `${JSON.stringify({ categories, topChunks }, null, 2)}\n`,
);
// TSV feeds the base-vs-head delta: category<TAB>gzip<TAB>raw.
writeFileSync(
  join(out, "bundle-size.tsv"),
  `${Object.entries(categories)
    .map(([name, { gzip, raw }]) => `${name}\t${gzip}\t${raw}`)
    .join("\n")}\n`,
);

console.log(md);
console.log(`\n✓ wrote ${join(out, "bundle-size.json")}`);
console.log(`       ${join(out, "bundle-size.tsv")}`);
console.log(`       ${join(out, "bundle-size.md")}`);
