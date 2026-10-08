// The tag-based boundary check: fed synthetic graphs and a scratch workspace,
// it rejects every forbidden edge and a Cargo path dependency the Nx graph does
// not declare, and passes the repository's real graph.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { boundaryViolations, cargoPathDeps } from "../check-boundaries.mjs";

const script = resolve(import.meta.dirname, "../check-boundaries.mjs");

function graph(edges, extraTags = {}) {
  const tags = {
    web: ["type:app"],
    "web-e2e": ["type:e2e"],
    plugin: ["type:cli"],
    protocol: ["type:contract"],
    e2e: ["type:test"],
    ...extraTags,
  };
  const nodes = Object.fromEntries(
    Object.entries(tags).map(([name, t]) => [name, { data: { tags: t } }]),
  );
  const dependencies = Object.fromEntries(Object.keys(tags).map((name) => [name, []]));
  for (const [source, target] of edges)
    dependencies[source].push({ source, target, type: "implicit" });
  return { nodes, dependencies };
}

describe("boundaryViolations", () => {
  it("allows consumers to depend on a contract and e2e projects to depend on what they test", () => {
    const ok = graph([
      ["plugin", "protocol"],
      ["web-e2e", "web"],
      ["web-e2e", "plugin"],
      ["e2e", "plugin"],
      ["plugin", "npm:serde"],
    ]);
    assert.deepEqual(boundaryViolations(ok), []);
  });

  it("rejects any project depending on an e2e or test project", () => {
    assert.deepEqual(boundaryViolations(graph([["web", "web-e2e"]])), [
      "web depends on web-e2e, a type:e2e project (a leaf)",
    ]);
    assert.deepEqual(boundaryViolations(graph([["plugin", "e2e"]])), [
      "plugin depends on e2e, a type:test project (a leaf)",
    ]);
  });

  it("rejects a contract depending on a consumer", () => {
    assert.deepEqual(boundaryViolations(graph([["protocol", "plugin"]])), [
      "protocol is type:contract but depends on plugin, which is not",
    ]);
  });

  it("rejects a Cargo path dependency the Nx graph does not declare", () => {
    assert.deepEqual(boundaryViolations(graph([]), { plugin: ["protocol"] }), [
      "crates/plugin/Cargo.toml depends on protocol but the Nx graph has no plugin -> protocol edge (declare it in implicitDependencies)",
    ]);
  });
});

describe("cargoPathDeps", () => {
  it("reads inline tables, sub-tables and either quote, keeping only sibling crates", () => {
    const manifest = [
      "[dependencies]",
      'a = { path = "../a" }',
      "b = { path = '../b', version = \"1\" }",
      '# c = { path = "../c" }',
      "[dev-dependencies.d]",
      'path = "../../crates/d"',
      "[dependencies.vendored]",
      'path = "vendor/x"',
    ].join("\n");
    assert.deepEqual(cargoPathDeps(manifest, "/r/crates/me", "/r/crates"), ["a", "b", "d"]);
  });
});

describe("check-boundaries.mjs CLI", () => {
  function run(edges, crates) {
    const dir = mkdtempSync(join(tmpdir(), "boundaries-"));
    try {
      const file = join(dir, "graph.json");
      writeFileSync(file, JSON.stringify({ graph: graph(edges) }));
      for (const [crate, manifest] of Object.entries(crates)) {
        mkdirSync(join(dir, "crates", crate), { recursive: true });
        writeFileSync(join(dir, "crates", crate, "Cargo.toml"), manifest);
      }
      mkdirSync(join(dir, "crates"), { recursive: true });
      return spawnSync("node", [script, "--graph", file, "--workspace", dir], { encoding: "utf8" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("exits non-zero naming a forbidden edge read from Cargo", () => {
    const manifest = '[dependencies]\nplugin = { path = "../plugin" }\n';
    const result = run([["protocol", "plugin"]], { protocol: manifest });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /boundary: protocol is type:contract but depends on plugin/);
  });

  it("rejects a graph file that is not an nx project graph", () => {
    const dir = mkdtempSync(join(tmpdir(), "boundaries-"));
    try {
      const file = join(dir, "graph.json");
      const ghost = graph([]);
      ghost.dependencies.ghost = [{ source: "ghost", target: "plugin", type: "implicit" }];
      writeFileSync(file, JSON.stringify({ graph: ghost }));
      mkdirSync(join(dir, "crates"));
      const result = spawnSync("node", [script, "--graph", file, "--workspace", dir], {
        encoding: "utf8",
      });
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        /not an nx project graph \(dependencies listed for unknown project ghost\)/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails rather than skipping a crate whose manifest cannot be read", {
    skip: process.platform === "win32" || process.getuid?.() === 0,
  }, () => {
    const dir = mkdtempSync(join(tmpdir(), "boundaries-"));
    try {
      const file = join(dir, "graph.json");
      writeFileSync(file, JSON.stringify({ graph: graph([]) }));
      mkdirSync(join(dir, "crates", "plugin"), { recursive: true });
      const manifest = join(dir, "crates", "plugin", "Cargo.toml");
      writeFileSync(manifest, "[package]\n");
      chmodSync(manifest, 0o000);
      const result = spawnSync("node", [script, "--graph", file, "--workspace", dir], {
        encoding: "utf8",
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /EACCES/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes the repository's own graph", () => {
    const result = spawnSync("node", [script], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /boundaries: ok/);
  });
});
