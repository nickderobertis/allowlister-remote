#!/usr/bin/env node

// Deterministic heap-footprint report for the PWA — the memory-side analogue of
// the Rust binaries' allocation reports (`just bench-allocs`) and the web
// bundle-size report. It answers what the other web perf lanes cannot: how much
// heap each pending request retains while it sits in the inbox, and whether
// resolving a request actually releases it.
//
// It runs the heap harness (apps/web/src/perf/heap.perf.ts) under Vitest, which
// walks the retained object graph (object/array/string counts — deterministic,
// not process.memoryUsage()) and writes heap.json. This script renders that into
// a markdown table; the numbers are reproducible for a given build, so the
// base-vs-PR delta is trustworthy the way bundle size is.
//
// Usage:
//   scripts/web-heap.mjs                  Measure (runs the harness, prints md).
//   scripts/web-heap.mjs report BASE HEAD Markdown delta table from two
//                                         heap.tsv files.
//
// Results: markdown on stdout plus heap.json / heap.tsv / heap.md under
// ${HEAP_OUT:-target/web-perf}.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = join(repoRoot, "apps/web");
const out = process.env.HEAP_OUT ?? join(repoRoot, "target/web-perf");

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

// `report` joins a base and a head TSV (metric<TAB>value) into a markdown delta
// table. It touches no harness output, so CI can run it after checking back out
// of the base revision.
function reportDelta(baseTsv, headTsv) {
  const parse = (path) => {
    const rows = new Map();
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const [name, value] = line.split("\t");
      rows.set(name, Number(value));
    }
    return rows;
  };
  const base = parse(baseTsv);
  const head = parse(headTsv);

  const lines = ["| metric | base | head | Δ |", "|---|---:|---:|---:|"];
  for (const [name, value] of head) {
    const prior = base.get(name);
    if (prior === undefined) {
      lines.push(`| ${name} | — | ${value} | new |`);
    } else if (prior === 0) {
      // A zero base (e.g. the retained-after-drain leak metric, which should stay
      // zero) has no percentage; show the absolute change instead.
      lines.push(`| ${name} | ${prior} | ${value} | ${value === 0 ? "0" : `+${value}`} |`);
    } else {
      const delta = ((value - prior) / prior) * 100;
      const sign = delta >= 0 ? "+" : "";
      lines.push(`| ${name} | ${prior} | ${value} | ${sign}${delta.toFixed(2)}% |`);
    }
  }
  return lines.join("\n");
}

if (process.argv[2] === "report") {
  const [, , , baseTsv, headTsv] = process.argv;
  if (!baseTsv || !headTsv) fail("usage: web-heap.mjs report BASE.tsv HEAD.tsv");
  console.log(reportDelta(baseTsv, headTsv));
  process.exit(0);
}

mkdirSync(out, { recursive: true });

// Run the harness; it writes heap.json itself.
const result = spawnSync("npx", ["vitest", "run", "--config", "vitest.heap.config.ts"], {
  cwd: appDir,
  stdio: "inherit",
  env: { ...process.env, HEAP_OUT: out },
});
if (result.status !== 0) fail("heap-footprint harness failed");

const data = JSON.parse(readFileSync(join(out, "heap.json"), "utf8"));

const lines = [
  "Per-request retained decision surface (objects · string chars — lower is better):",
  "",
  "| request | objects | arrays | strings | string chars |",
  "|---|---:|---:|---:|---:|",
];
for (const entry of data.perRequest) {
  const f = entry.footprint;
  lines.push(`| \`${entry.id}\` | ${f.objects} | ${f.arrays} | ${f.strings} | ${f.stringChars} |`);
}

lines.push("");
lines.push("Footprint vs script length (one shell card):");
lines.push("");
lines.push("| fragments | objects | string chars |");
lines.push("|---:|---:|---:|");
for (const entry of data.scaling) {
  lines.push(
    `| ${entry.scriptLen} | ${entry.footprint.objects} | ${entry.footprint.stringChars} |`,
  );
}

const r = data.retention;
lines.push("");
lines.push("Inbox retention over a session (snapshot + added → resolve all):");
lines.push("");
lines.push("| metric | value |");
lines.push("|---|---:|");
lines.push(`| requests held at peak | ${r.heldCount} |`);
lines.push(`| objects per held card | ${r.perHeld.objects} |`);
lines.push(`| string chars per held card | ${r.perHeld.stringChars} |`);
lines.push(
  `| retained after resolving all | ${r.drainedCount} requests, ${r.drainedFootprint.stringChars} chars |`,
);
lines.push(
  `| released clean (no leak) | ${r.releasedClean ? "✅ yes" : "❌ NO — retained state after drain"} |`,
);

const md = lines.join("\n");

// TSV feeds the base-vs-head delta: the deterministic headline metrics.
const total = data.totalPerRequest;
const tsv = [
  `total surface objects\t${total.objects}`,
  `total surface arrays\t${total.arrays}`,
  `total surface string chars\t${total.stringChars}`,
  `objects per held card\t${r.perHeld.objects}`,
  `string chars per held card\t${r.perHeld.stringChars}`,
  `retained after drain (chars)\t${r.drainedFootprint.stringChars}`,
].join("\n");

writeFileSync(join(out, "heap.md"), `${md}\n`);
writeFileSync(join(out, "heap.tsv"), `${tsv}\n`);

console.log(`\n${md}\n`);
console.log(`✓ wrote ${join(out, "heap.json")}`);
console.log(`       ${join(out, "heap.tsv")}`);
console.log(`       ${join(out, "heap.md")}`);
