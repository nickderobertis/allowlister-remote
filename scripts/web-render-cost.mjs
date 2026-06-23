#!/usr/bin/env node

// Deterministic render-cost report for the PWA — the render-side analogue of the
// plugin's cachegrind instruction counts (scripts/bench-instructions.sh) and the
// web bundle-size report. It answers a question the other web perf lanes cannot:
// how much work the live component tree redoes on a state change that should not
// touch most of it, and how much of that React Compiler removes.
//
// It runs the render-cost harness (apps/web/src/perf/render-cost.perf.tsx) twice
// under Vitest + jsdom — once without React Compiler (baseline) and once with it
// (REACT_COMPILER=1, wired through @rolldown/plugin-babel exactly as the
// `reactCompiler: true` production build is) — then diffs the two JSON reports.
//
// The headline metric is "decision-surface recomputations": how many times the
// pure functions every card runs (requestHeadline, flaggedFragments,
// scriptLines, toolCallLines, triggeredRules — the same surface decision.bench.ts
// times) are called while handling one interaction. It is a call count, so the
// base-vs-compiler delta is reproducible and trustworthy the way bundle size is;
// the Profiler commit duration is wall-clock and reported only as context.
//
// Usage:   scripts/web-render-cost.mjs
// Results: markdown table on stdout plus render-cost.{baseline,compiler}.json and
//          render-cost.md under ${RENDER_COST_OUT:-target/web-perf}.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = join(repoRoot, "apps/web");
const out = process.env.RENDER_COST_OUT ?? join(repoRoot, "target/web-perf");
mkdirSync(out, { recursive: true });

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

// Run the harness once in the given mode. The harness writes
// render-cost.<mode>.json itself; we only check it exited cleanly.
function runHarness(compiler) {
  const result = spawnSync("npx", ["vitest", "run", "--config", "vitest.render-cost.config.ts"], {
    cwd: appDir,
    stdio: "inherit",
    env: { ...process.env, REACT_COMPILER: compiler ? "1" : "", RENDER_COST_OUT: out },
  });
  if (result.status !== 0) {
    fail(`render-cost harness failed (${compiler ? "compiler" : "baseline"} mode)`);
  }
}

runHarness(false);
runHarness(true);

const baseline = JSON.parse(readFileSync(join(out, "render-cost.baseline.json"), "utf8"));
const compiler = JSON.parse(readFileSync(join(out, "render-cost.compiler.json"), "utf8"));

const INTERACTIONS = [
  ["toggleShortcuts", "Toggle shortcuts panel (unrelated state)"],
  ["arrowNav", "Arrow-key inbox navigation"],
];

const lines = [
  `Inbox size: ${baseline.inboxSize} cards · first paint: ${baseline.mountDecisionCalls} decision calls`,
  "",
  "Decision-surface recomputations per interaction (lower is better):",
  "",
  "| interaction | baseline | compiler | Δ |",
  "|---|---:|---:|---:|",
];
for (const [key, label] of INTERACTIONS) {
  const base = baseline.interactions[key].decisionCalls;
  const comp = compiler.interactions[key].decisionCalls;
  const delta = base > 0 ? `−${base - comp} (−${Math.round(((base - comp) / base) * 100)}%)` : "—";
  lines.push(`| ${label} | ${base} | ${comp} | ${delta} |`);
}
lines.push("");
lines.push("Profiler commit duration (ms, wall-clock — noisy, context only):");
lines.push("");
lines.push("| interaction | baseline | compiler |");
lines.push("|---|---:|---:|");
for (const [key, label] of INTERACTIONS) {
  const base = baseline.interactions[key].durationMs.toFixed(2);
  const comp = compiler.interactions[key].durationMs.toFixed(2);
  lines.push(`| ${label} | ${base} | ${comp} |`);
}

const report = lines.join("\n");
console.log(`\n${report}\n`);
writeFileSync(join(out, "render-cost.md"), `${report}\n`);
