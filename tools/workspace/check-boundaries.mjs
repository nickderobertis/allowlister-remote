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
//   --workspace  the Cargo workspace root whose crates/* are cross-checked
// Node built-ins only.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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

// The slice of `nx graph --file` output this check reads, validated before use so
// a changed or truncated graph fails loudly instead of passing with no edges.
function graphShapeError(graph) {
  if (!graph || typeof graph !== "object") return "no `graph` object";
  if (!graph.nodes || typeof graph.nodes !== "object") return "no `nodes` object";
  if (!graph.dependencies || typeof graph.dependencies !== "object")
    return "no `dependencies` object";
  if (Object.keys(graph.nodes).length === 0) return "no projects";
  const badNode = Object.entries(graph.nodes).find(([, node]) => {
    const tags = node?.data?.tags;
    return !Array.isArray(tags) || tags.some((tag) => typeof tag !== "string");
  });
  if (badNode) return `${badNode[0]} has no tags array`;
  // Shape of every dependency list first, so the membership checks below can
  // read `target` safely.
  const badDeps = Object.entries(graph.dependencies).find(
    ([, deps]) => !Array.isArray(deps) || deps.some((dep) => typeof dep?.target !== "string"),
  );
  if (badDeps) return `${badDeps[0]} dependencies are not a list of { target } records`;
  const missing = Object.keys(graph.nodes).find((name) => !(name in graph.dependencies));
  if (missing) return `no dependency list for ${missing}`;
  const isKnown = (name) => name in graph.nodes || name.startsWith("npm:");
  const unknown = Object.keys(graph.dependencies).find((name) => !isKnown(name));
  if (unknown) return `dependencies listed for unknown project ${unknown}`;
  for (const [source, deps] of Object.entries(graph.dependencies)) {
    const dangling = deps.find((dep) => !isKnown(dep.target));
    if (dangling) return `${source} depends on unknown project ${dangling.target}`;
  }
  return undefined;
}

function validateGraph(graph, source) {
  const error = graphShapeError(graph);
  if (error) throw new Error(`${source}: not an nx project graph (${error})`);
  return graph;
}

function loadGraph(file, workspace) {
  if (file) return validateGraph(JSON.parse(readFileSync(file, "utf8")).graph, file);
  const dir = mkdtempSync(join(tmpdir(), "nx-graph-"));
  try {
    const out = join(dir, "graph.json");
    const run = spawnSync("npx", ["nx", "graph", `--file=${out}`], {
      cwd: workspace,
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    if (run.status !== 0) throw new Error(`nx graph failed:\n${run.stdout}${run.stderr}`);
    return validateGraph(JSON.parse(readFileSync(out, "utf8")).graph, "nx graph");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Each workspace crate's path dependencies on sibling crates, every kind, from
// `cargo metadata` — Cargo's own parse of the manifests, so a malformed manifest
// fails here instead of reading as "no dependencies".
export function cargoCrateEdges(metadata, cratesDir) {
  if (!Array.isArray(metadata?.packages)) throw new Error("cargo metadata: no `packages` list");
  const crates = {};
  for (const pkg of metadata.packages) {
    if (typeof pkg?.manifest_path !== "string" || !Array.isArray(pkg.dependencies)) {
      throw new Error(`cargo metadata: malformed package ${JSON.stringify(pkg?.name)}`);
    }
    const crateDir = dirname(pkg.manifest_path);
    if (dirname(crateDir) !== cratesDir) continue;
    crates[basename(crateDir)] = pkg.dependencies
      .filter((dep) => typeof dep?.path === "string" && dirname(dep.path) === cratesDir)
      .map((dep) => basename(dep.path));
  }
  return crates;
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
    for (const { target } of deps.filter(({ target }) => !target.startsWith("npm:"))) {
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
  const run = spawnSync("cargo", ["metadata", "--format-version", "1", "--no-deps", "--offline"], {
    cwd: workspace,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (run.status !== 0) throw new Error(`cargo metadata failed:\n${run.stderr}`);
  return cargoCrateEdges(JSON.parse(run.stdout), realpathSync(join(workspace, "crates")));
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
