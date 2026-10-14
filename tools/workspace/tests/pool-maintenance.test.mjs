// Pool maintenance: onevcs.toml names the `pool-maintenance` recipe, the recipe
// prunes every target dir .cargo/config.toml sets, the real pruner removes only
// superseded builds older than the window, `bootstrap` installs the pinned pruner
// once, and the pool-maintenance budget is reached by the release PR alone —
// never by a per-change task graph, which nx itself is asked for.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "../../..");
const scratch = mkdtempSync(join(tmpdir(), "pool-maintenance-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
    ...options,
  });
}

function just(args, options) {
  return run("just", ["--justfile", join(root, "justfile"), ...args], options);
}

function recipeBody(name) {
  const shown = just(["--show", name]);
  assert.equal(shown.status, 0, shown.stderr);
  return shown.stdout;
}

describe("onevcs.toml", () => {
  const declaration = readFileSync(join(root, "onevcs.toml"), "utf8");

  it("declares schema 1 and a pool maintenance command naming a real recipe", () => {
    assert.match(declaration, /^schema_version = 1$/m);
    assert.match(declaration, /^\[pool\.maintain\]$/m);
    assert.match(declaration, /^command = \["just", "pool-maintenance"\]$/m);
    assert.match(declaration, /^timeout = "30m"$/m);
    assert.match(recipeBody("pool-maintenance"), /cargo-prune-superseded --keep-within 2d /);
  });
});

describe("pool-maintenance recipe", () => {
  it("prunes every target dir a committed .cargo/config.toml sets", () => {
    const configs = run("git", ["ls-files", "*.cargo/config.toml", ".cargo/config.toml"])
      .stdout.split("\n")
      .filter(Boolean);
    assert.ok(configs.length > 0, "no .cargo/config.toml is committed");
    const line = recipeBody("pool-maintenance")
      .split("\n")
      .find((l) => l.includes("cargo-prune-superseded"));
    const named = line.trim().split(/\s+/).slice(3);
    const expected = new Set();
    for (const config of configs) {
      // cargo resolves a config's relative target-dir against the directory
      // holding `.cargo/`.
      const match = readFileSync(join(root, config), "utf8").match(/^target-dir = "([^"]+)"$/m);
      const base = dirname(dirname(join(root, config)));
      expected.add(match ? relative(root, resolve(base, match[1])) : "target");
    }
    assert.deepEqual(new Set(named), expected);
  });

  // A real target dir: unit `alpha` has two superseded builds older than the
  // window and a fresh newest one; `beta`'s only build is old but newest; `gamma`
  // has two builds inside the window. Only alpha's two old builds may go.
  it("removes superseded builds older than 2 days and keeps the rest", () => {
    const work = join(scratch, "prune");
    const profile = join(work, "target", "debug");
    const day = 24 * 60 * 60;
    const now = Date.now() / 1000;
    const builds = {
      alpha: { "00000000000000a1": now - 5 * day, "00000000000000a2": now - 4 * day },
      beta: { "00000000000000b1": now - 10 * day },
      gamma: { "00000000000000c1": now - day, "00000000000000c2": now },
    };
    builds.alpha["00000000000000a3"] = now - 3600;
    for (const [unit, hashes] of Object.entries(builds)) {
      for (const [hash, mtime] of Object.entries(hashes)) {
        const fingerprint = join(profile, ".fingerprint", `${unit}-${hash}`);
        mkdirSync(fingerprint, { recursive: true });
        const lib = join(profile, "deps", `lib${unit}-${hash}.rlib`);
        mkdirSync(dirname(lib), { recursive: true });
        writeFileSync(join(fingerprint, "lib"), hash);
        writeFileSync(lib, hash);
        for (const path of [join(fingerprint, "lib"), fingerprint, lib]) {
          utimesSync(path, mtime, mtime);
        }
      }
    }
    const pruned = just(["--working-directory", work, "pool-maintenance"]);
    assert.equal(pruned.status, 0, pruned.stderr);
    assert.match(pruned.stdout, /cargo-prune-superseded: target: removed 2 superseded build\(s\)/);
    assert.deepEqual(readdirSync(join(profile, "deps")).sort(), [
      "libalpha-00000000000000a3.rlib",
      "libbeta-00000000000000b1.rlib",
      "libgamma-00000000000000c1.rlib",
      "libgamma-00000000000000c2.rlib",
    ]);
  });
});

describe("bootstrap", () => {
  // Stubs record their argv; `cargo-prune-superseded --version` prints
  // $STUB_VERSION, standing in for whatever release is already on PATH.
  const stubs = join(scratch, "stubs");
  mkdirSync(stubs, { recursive: true });
  for (const tool of ["npm", "cargo"]) {
    const path = join(stubs, tool);
    writeFileSync(path, `#!/usr/bin/env bash\necho "$*" >> "${stubs}/${tool}.args"\n`);
    chmodSync(path, 0o755);
  }
  const versionStub = join(stubs, "cargo-prune-superseded");
  writeFileSync(versionStub, '#!/usr/bin/env bash\necho "cargo-prune-superseded $STUB_VERSION"\n');
  chmodSync(versionStub, 0o755);

  const pinned = just(["--evaluate", "prune_superseded_version"]).stdout.trim();

  function bootstrap(version) {
    rmSync(join(stubs, "cargo.args"), { force: true });
    const ran = just(["bootstrap"], {
      env: {
        PATH: `${stubs}${delimiter}${process.env.PATH}`,
        HOME: process.env.HOME,
        STUB_VERSION: version,
      },
    });
    assert.equal(ran.status, 0, ran.stderr);
    const file = join(stubs, "cargo.args");
    return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : [];
  }

  it("installs the pinned pruner release when another one is on PATH", () => {
    assert.match(pinned, /^\d+\.\d+\.\d+$/);
    assert.deepEqual(bootstrap("0.0.1"), [
      "fetch",
      `install --locked cargo-prune-superseded --version ${pinned}`,
    ]);
  });

  it("skips the install when the pinned release is already on PATH", () => {
    assert.deepEqual(bootstrap(pinned), ["fetch"]);
  });
});

describe("pool-maintenance budget selection", () => {
  const nx = (args) => {
    const ran = run("npx", ["nx", ...args]);
    assert.equal(ran.status, 0, ran.stderr);
    return ran.stdout;
  };
  const taskIds = (args) => {
    const file = join(mkdtempSync(join(scratch, "graph-")), "tasks.json");
    nx([...args, `--graph=${file}`]);
    return Object.keys(JSON.parse(readFileSync(file, "utf8")).tasks.tasks);
  };
  // Every target the gate asks nx for, read from the dry runs of `check all` and
  // the `test all` it calls.
  const dryRuns = [just(["-n", "check", "all"]), just(["-n", "test", "all"])];
  const gateTargets = dryRuns.flatMap((dryRun) =>
    [...dryRun.stderr.matchAll(/^npx nx run-many -t (.+)$/gm)].flatMap((m) => m[1].split(" ")),
  );
  const ownTasks = (ids) => ids.filter((id) => id.startsWith("pool-maintenance:"));

  it("the gate's targets include the budget targets", () => {
    for (const dryRun of dryRuns) assert.equal(dryRun.status, 0, dryRun.stderr);
    for (const target of ["budgets", "budgets-host", "test", "coverage", "lint"]) {
      assert.ok(gateTargets.includes(target), `${target} missing from ${gateTargets}`);
    }
  });

  it("no gate task graph over every project holds a pool-maintenance task", () => {
    const ids = taskIds(["run-many", "-t", ...gateTargets]);
    assert.ok(ids.length > 0);
    assert.deepEqual(ownTasks(ids), []);
  });

  it("no affected task graph holds one, whatever the change", () => {
    const changes = [
      "crates/allowlister-remote-plugin/src/lib.rs",
      "pool-maintenance/measure.sh",
      "pool-maintenance/budgets.yaml",
      "pool-maintenance/project.json",
      "onevcs.toml",
      "justfile",
    ];
    for (const file of changes) {
      const ids = taskIds(["affected", `--files=${file}`, "-t", ...gateTargets]);
      assert.deepEqual(ownTasks(ids), [], file);
    }
    // The project is reached by its own files; it simply has no gate target.
    const projects = JSON.parse(
      nx(["show", "projects", "--affected", "--files=pool-maintenance/measure.sh", "--json"]),
    );
    assert.ok(projects.includes("pool-maintenance"), projects);
  });

  it("the release PR runs the budget check after its gate passes", () => {
    const check = parse(readFileSync(join(root, ".github/workflows/check.yml"), "utf8"));
    const steps = check.jobs.check.steps;
    const gate = steps.findIndex((s) => s.run?.includes("just check"));
    const budget = steps.findIndex((s) =>
      s.run?.includes("nx run pool-maintenance:budgets-release"),
    );
    assert.ok(gate >= 0 && budget > gate, `gate ${gate}, budget ${budget}`);
    assert.equal(steps[budget].if, "needs.setup.outputs.tier == 'all'");
    assert.deepEqual(taskIds(["run", "pool-maintenance:budgets-release"]), [
      "pool-maintenance:budgets-release",
    ]);
  });

  it("the root budgets file does not register the budget", () => {
    const rootBudgets = join(root, "budgets.yaml");
    if (existsSync(rootBudgets)) {
      assert.doesNotMatch(
        readFileSync(rootBudgets, "utf8"),
        /allowlister-remote-pool-maintenance-seconds/,
      );
    }
  });
});
