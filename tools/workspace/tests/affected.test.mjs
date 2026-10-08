// Affected selection, asked of nx itself: a file reaches exactly the projects
// that read it (their target inputs) and their dependents, a crate change never
// reaches `web`, and the e2e and coverage tasks run what they depend on first.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

const root = resolve(import.meta.dirname, "../../..");
const nx = (args) => {
  const run = spawnSync("npx", ["nx", ...args], {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
};
const affected = (file) =>
  new Set(JSON.parse(nx(["show", "projects", "--affected", `--files=${file}`, "--json"])));

const RUST_CRATES = [
  "allowlister-remote-plugin",
  "allowlister-remote-broker",
  "allowlister-remote-daemon",
  "allowlister-remote-protocol",
  "allowlister-remote-e2e",
];

function assertSelection(file, { includes = [], excludes = [] }) {
  const got = affected(file);
  for (const name of includes)
    assert.ok(got.has(name), `${file} should select ${name}: ${[...got]}`);
  for (const name of excludes)
    assert.ok(!got.has(name), `${file} should not select ${name}: ${[...got]}`);
}

describe("affected selection", () => {
  it("a change confined to one crate selects it and its dependents, never web", () => {
    assertSelection("crates/allowlister-remote-plugin/src/lib.rs", {
      includes: [
        "allowlister-remote-plugin",
        "allowlister-remote-e2e",
        "web-e2e",
        "rust-workspace",
      ],
      excludes: [
        "web",
        "allowlister-remote-broker",
        "allowlister-remote-daemon",
        "allowlister-remote-plugin-npm",
      ],
    });
    assertSelection("crates/allowlister-remote-protocol/src/lib.rs", {
      includes: RUST_CRATES,
      excludes: ["web", "allowlister-remote-plugin-npm"],
    });
  });

  it("the protocol fixture also selects web, whose contract test reads it", () => {
    assertSelection("crates/allowlister-remote-protocol/wire/protocol-v3.json", {
      includes: ["web", ...RUST_CRATES],
    });
  });

  it("a workflow read by one project selects only that project", () => {
    assert.deepEqual([...affected(".github/workflows/notignored.yml")], ["workspace"]);
    assertSelection(".github/workflows/bench.yml", {
      includes: [
        "web",
        "allowlister-remote-plugin",
        "allowlister-remote-broker",
        "allowlister-remote-daemon",
      ],
      excludes: ["allowlister-remote-plugin-npm", "allowlister-remote-protocol"],
    });
  });

  it("a script selects each project that reads it and leaves the rest", () => {
    assertSelection("scripts/serve-web.mjs", {
      includes: ["web", "web-e2e"],
      excludes: RUST_CRATES,
    });
    assertSelection("scripts/bench.sh", {
      includes: ["allowlister-remote-plugin"],
      excludes: ["web", "allowlister-remote-broker", "allowlister-remote-plugin-npm"],
    });
    assertSelection("scripts/stage-npm-package.mjs", {
      includes: ["workspace"],
      excludes: ["web", "web-e2e", ...RUST_CRATES],
    });
    assert.deepEqual([...affected("justfile")], ["workspace"]);
  });

  it("a supply-chain policy edit selects only the supply-chain gate", () => {
    assert.deepEqual([...affected("deny.toml")], ["rust-supply-chain"]);
  });

  it("a workflow or hook edit never selects the Rust coverage aggregate", () => {
    for (const file of [".github/workflows/check.yml", "scripts/session-setup.sh", "justfile"]) {
      assertSelection(file, { excludes: ["rust-workspace", ...RUST_CRATES] });
    }
  });
});

describe("task ordering", () => {
  function taskGraph(target) {
    const dir = mkdtempSync(join(tmpdir(), "nx-tasks-"));
    try {
      const file = join(dir, "tasks.json");
      nx(["run", target, `--graph=${file}`]);
      return JSON.parse(readFileSync(file, "utf8")).tasks;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("web-e2e's test-e2e builds web and the three crates first", () => {
    const graph = taskGraph("web-e2e:test-e2e");
    assert.deepEqual(
      new Set(graph.dependencies["web-e2e:test-e2e"]),
      new Set([
        "web:build",
        "allowlister-remote-plugin:build",
        "allowlister-remote-broker:build",
        "allowlister-remote-daemon:build",
      ]),
    );
  });

  it("coverage merges every crate's test run, each after a profile clean", () => {
    const graph = taskGraph("rust-workspace:coverage");
    assert.deepEqual(
      new Set(graph.dependencies["rust-workspace:coverage"]),
      new Set(RUST_CRATES.map((crate) => `${crate}:test`)),
    );
    for (const crate of RUST_CRATES) {
      assert.ok(
        graph.dependencies[`${crate}:test`].includes("rust-workspace:coverage-clean"),
        crate,
      );
    }
  });
});
