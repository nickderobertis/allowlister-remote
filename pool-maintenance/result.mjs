// The JSON measure.sh reads and writes, each shape validated before use.
//   crates                                   stdin: `cargo metadata --no-deps`; prints one package name per line
//   merge TIMED BACKLOG OUT CREATED REMOVED  writes TIMED's onebudgetspec result to OUT, its detail
//                                            extended with the entry counts and BACKLOG's seconds
import { readFileSync, writeFileSync } from "node:fs";

function fail(message) {
  console.error(`result.mjs: ${message}`);
  process.exit(2);
}

function crates() {
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(0, "utf8"));
  } catch (error) {
    fail(`cargo metadata did not print JSON (${error.message})`);
  }
  const packages = metadata?.packages;
  if (!Array.isArray(packages) || packages.length === 0) {
    fail("cargo metadata listed no `packages`");
  }
  for (const pkg of packages) {
    if (typeof pkg?.name !== "string" || !/^[A-Za-z0-9_-]+$/.test(pkg.name)) {
      fail(`cargo metadata listed a package without a plain name: ${JSON.stringify(pkg?.name)}`);
    }
    console.log(pkg.name);
  }
}

// A cargo-prune-superseded onebudgetspec report: a finite seconds value and its detail.
function readReport(file) {
  let report;
  try {
    report = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`${file} is not the pruner's onebudgetspec report (${error.message})`);
  }
  if (!Number.isFinite(report?.value) || report.value < 0 || typeof report.detail !== "string") {
    fail(`${file} lacks a non-negative numeric \`value\` and a string \`detail\``);
  }
  return report;
}

function merge(timedFile, backlogFile, out, created, removed) {
  for (const [name, count] of [
    ["created", created],
    ["removed", removed],
  ]) {
    if (!/^\s*\d+\s*$/.test(count ?? "")) fail(`${name} entry count must be an integer`);
  }
  const timed = readReport(timedFile);
  const backlog = readReport(backlogFile);
  const detail = [
    timed.detail,
    `alternative entries created: ${created.trim()}`,
    `entries removed: ${removed.trim()}`,
    `untimed backlog pass (not in the figure): ${backlog.value} seconds`,
  ].join("; ");
  writeFileSync(out, JSON.stringify({ value: timed.value, detail }));
}

const [command, ...args] = process.argv.slice(2);
if (command === "crates" && args.length === 0) crates();
else if (command === "merge" && args.length === 5) merge(...args);
else fail("usage: result.mjs crates | merge TIMED BACKLOG OUT CREATED REMOVED");
