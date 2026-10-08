#!/usr/bin/env node
// Enforce the project graph's module boundaries from project tags, and keep the
// Nx graph honest about Cargo. Nx does not infer Rust dependencies here, so the
// crates' edges are declared as `implicitDependencies`; this check also fails when
// a Cargo path dependency between workspace crates has no matching Nx edge, so a
// boundary cannot be bypassed by adding the Cargo edge alone.
//
// Rules (by tag):
//   * a `type:e2e` or `type:test` project is a leaf — no project depends on it;
//   * a `type:contract` project depends only on other `type:contract` projects.
//
// Usage: node tools/workspace/check-boundaries.mjs [--graph FILE] [--workspace DIR]
//   --graph      read the graph from an `nx graph --file` JSON instead of asking nx
//   --workspace  the repository root whose crates/*/Cargo.toml are cross-checked
// Node built-ins only.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LEAF_TYPES = ["type:e2e", "type:test"];
const CONTRACT = "type:contract";

function parseArgs(argv) {
  const args = { graph: undefined, workspace: resolve(import.meta.dirname, "../..") };
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if ((flag !== "--graph" && flag !== "--workspace") || value === undefined) {
      throw new Error(`usage: check-boundaries.mjs [--graph FILE] [--workspace DIR] (got ${flag})`);
    }
    args[flag.slice(2)] = resolve(value);
  }
  return args;
}

function loadGraph(file, workspace) {
  if (file) return JSON.parse(readFileSync(file, "utf8")).graph;
  const dir = mkdtempSync(join(tmpdir(), "nx-graph-"));
  try {
    const out = join(dir, "graph.json");
    const run = spawnSync("npx", ["nx", "graph", `--file=${out}`], {
      cwd: workspace,
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    if (run.status !== 0) throw new Error(`nx graph failed:\n${run.stdout}${run.stderr}`);
    return JSON.parse(readFileSync(out, "utf8")).graph;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// `name = { path = "../other" }` lines in a crate manifest, as directory names.
function cargoPathDeps(manifest) {
  return [...manifest.matchAll(/path\s*=\s*"\.\.\/([^"]+)"/g)].map((match) => match[1]);
}

function tagViolations(graph, source, target) {
  const tags = (name) => graph.nodes[name]?.data?.tags ?? [];
  const violations = [];
  const leaf = LEAF_TYPES.find((type) => tags(target).includes(type));
  if (leaf) violations.push(`${source} depends on ${target}, a ${leaf} project (a leaf)`);
  if (tags(source).includes(CONTRACT) && !tags(target).includes(CONTRACT)) {
    violations.push(`${source} is ${CONTRACT} but depends on ${target}, which is not`);
  }
  return violations;
}

export function boundaryViolations(graph, crates = {}) {
  const violations = [];
  const edges = new Set();
  for (const [source, deps] of Object.entries(graph.dependencies)) {
    // External (npm:) nodes are not projects and carry no tags.
    for (const { target } of deps.filter(({ target }) => graph.nodes[target])) {
      edges.add(`${source}->${target}`);
      violations.push(...tagViolations(graph, source, target));
    }
  }
  for (const [crate, deps] of Object.entries(crates)) {
    for (const dep of deps.filter((dep) => !edges.has(`${crate}->${dep}`))) {
      violations.push(
        `crates/${crate}/Cargo.toml depends on ${dep} but the Nx graph has no ${crate} -> ${dep} edge (declare it in implicitDependencies)`,
      );
    }
  }
  return violations;
}

function readCrates(workspace) {
  const cratesDir = join(workspace, "crates");
  const crates = {};
  for (const entry of readdirSync(cratesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      crates[entry.name] = cargoPathDeps(
        readFileSync(join(cratesDir, entry.name, "Cargo.toml"), "utf8"),
      );
    } catch {
      // not a crate directory
    }
  }
  return crates;
}

// Run as a script (CI pins Node 20, which has no `import.meta.main`).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const violations = boundaryViolations(
    loadGraph(args.graph, args.workspace),
    readCrates(args.workspace),
  );
  if (violations.length > 0) {
    for (const violation of violations) console.error(`boundary: ${violation}`);
    process.exit(1);
  }
  console.log("boundaries: ok");
}
