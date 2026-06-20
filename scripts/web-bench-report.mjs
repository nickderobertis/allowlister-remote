#!/usr/bin/env node

// Render a Vitest benchmark JSON (`vitest bench --outputJson`) into a compact
// markdown table for the PR performance comment. Vitest's own console output is
// a wide fixed-width table; this keeps just the columns that matter — ops/sec
// (higher is better), mean time, and the relative margin of error so a reader
// can tell signal from shared-runner noise.
//
// Usage: scripts/web-bench-report.mjs <bench.json>

import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("usage: web-bench-report.mjs <bench.json>");
  process.exit(1);
}

const data = JSON.parse(readFileSync(path, "utf8"));

const fmtHz = (hz) => {
  if (hz >= 1e6) return `${(hz / 1e6).toFixed(2)}M`;
  if (hz >= 1e3) return `${(hz / 1e3).toFixed(1)}k`;
  return hz.toFixed(0);
};
// Vitest reports times in milliseconds; the hot paths here are sub-microsecond.
const fmtMs = (ms) => (ms < 0.001 ? `${(ms * 1e6).toFixed(0)} ns` : `${(ms * 1e3).toFixed(2)} µs`);

const lines = ["| group | case | ops/sec | mean | ± |", "|---|---|---:|---:|---:|"];
for (const file of data.files ?? []) {
  for (const group of file.groups ?? []) {
    // Strip the "<file> > " prefix Vitest prepends to every group name.
    const groupName = group.fullName.replace(/^.*>\s*/, "");
    for (const bench of group.benchmarks ?? []) {
      lines.push(
        `| ${groupName} | ${bench.name} | ${fmtHz(bench.hz)} | ${fmtMs(bench.mean)} | ±${bench.rme.toFixed(1)}% |`,
      );
    }
  }
}

console.log(lines.join("\n"));
