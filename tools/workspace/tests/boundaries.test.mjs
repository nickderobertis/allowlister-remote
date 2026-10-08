// The tag-based boundary check: fed synthetic graphs and a scratch workspace,
// it rejects every forbidden edge and a Cargo path dependency the Nx graph does
// not declare, and passes the repository's real graph.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { boundaryViolations, cargoCrateEdges } from "../check-boundaries.mjs";

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

describe("cargoCrateEdges", () => {
  it("keeps every dependency kind on a sibling crate and ignores the rest", () => {
    const metadata = {
      packages: [
        {
          name: "me",
          manifest_path: "/r/crates/me/Cargo.toml",
          dependencies: [
            { name: "a", path: "/r/crates/a" },
            { name: "b", path: "/r/crates/b", kind: "dev" },
            { name: "serde_json" },
            { name: "vendored", path: "/r/crates/me/vendor/x" },
          ],
        },
        { name: "outside", manifest_path: "/r/tools/x/Cargo.toml", dependencies: [] },
      ],
    };
    assert.deepEqual(cargoCrateEdges(metadata, "/r/crates"), { me: ["a", "b"] });
  });

  it("rejects output that is not cargo metadata", () => {
    assert.throws(() => cargoCrateEdges({}, "/r/crates"), /no `packages` list/);
    assert.throws(
      () => cargoCrateEdges({ packages: [{ name: "x" }] }, "/r/crates"),
      /malformed package/,
    );
  });
});

describe("check-boundaries.mjs CLI", () => {
  // A scratch Cargo workspace: `crates` maps a crate name to its manifest's extra
  // TOML (e.g. a [dependencies] table), so `cargo metadata` parses real manifests.
  function run(edges, crates) {
    const dir = mkdtempSync(join(tmpdir(), "boundaries-"));
    try {
      const file = join(dir, "graph.json");
      writeFileSync(file, JSON.stringify({ graph: graph(edges) }));
      writeFileSync(
        join(dir, "Cargo.toml"),
        '[workspace]\nmembers = ["crates/*"]\nresolver = "2"\n',
      );
      for (const [crate, extra] of Object.entries(crates)) {
        mkdirSync(join(dir, "crates", crate, "src"), { recursive: true });
        writeFileSync(join(dir, "crates", crate, "src", "lib.rs"), "");
        writeFileSync(
          join(dir, "crates", crate, "Cargo.toml"),
          `[package]\nname = "${crate}"\nversion = "0.0.0"\nedition = "2021"\n${extra}`,
        );
      }
      return spawnSync("node", [script, "--graph", file, "--workspace", dir], { encoding: "utf8" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("exits non-zero naming a forbidden edge read from Cargo", () => {
    const manifest = '[dependencies]\nplugin = { path = "../plugin" }\n';
    const result = run([["protocol", "plugin"]], { protocol: manifest, plugin: "" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /boundary: protocol is type:contract but depends on plugin/);
  });

  it("exits non-zero when a Cargo dev-dependency has no Nx edge", () => {
    const manifest = '[dev-dependencies]\nplugin = { path = "../plugin" }\n';
    const result = run([], { web: manifest, plugin: "" });
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /crates\/web\/Cargo.toml depends on plugin but the Nx graph has no web -> plugin edge/,
    );
  });

  it("fails on a manifest Cargo cannot parse", () => {
    const result = run([], { plugin: "this is not TOML" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cargo metadata failed/);
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

  it("rejects malformed dependency records with a shape error, not a crash", () => {
    const dir = mkdtempSync(join(tmpdir(), "boundaries-"));
    try {
      const file = join(dir, "graph.json");
      const malformed = graph([]);
      malformed.dependencies.web = [null, { target: 7 }];
      writeFileSync(file, JSON.stringify({ graph: malformed }));
      mkdirSync(join(dir, "crates"));
      const result = spawnSync("node", [script, "--graph", file, "--workspace", dir], {
        encoding: "utf8",
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /web dependencies are not a list of \{ target \} records/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an edge onto a project the graph does not declare", () => {
    const dir = mkdtempSync(join(tmpdir(), "boundaries-"));
    try {
      const file = join(dir, "graph.json");
      const dangling = graph([["web", "phantom"]]);
      writeFileSync(file, JSON.stringify({ graph: dangling }));
      mkdirSync(join(dir, "crates"));
      const result = spawnSync("node", [script, "--graph", file, "--workspace", dir], {
        encoding: "utf8",
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /web depends on unknown project phantom/);
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
