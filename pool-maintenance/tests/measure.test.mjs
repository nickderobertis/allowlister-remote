// measure.sh's journey: the real script, run through the real `onebudgetspec
// check`, the real `pool-maintenance` recipe and the real pruner, reports one
// steady-state pass and refuses a run that does not stand for one.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { after, describe, it } from "node:test";

const root = resolve(import.meta.dirname, "../..");
const scratch = mkdtempSync(join(tmpdir(), "pool-maintenance-measure-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function run(command, args, options = {}) {
  return spawnSync(command, args, { cwd: root, encoding: "utf8", ...options });
}

// measure.sh, copied into a scratch tree and run through the real `onebudgetspec
// check`, the real recipe and the real pruner. Only cargo is a stub — its builds
// are the two minutes this unit tier cannot spend: `llvm-cov` writes one unit's
// entries, under a hash that depends on CARGO_PROFILE_DEV_DEBUG_ASSERTIONS like
// a real build's. STUB_ALT=none, STUB_ORDINARY=none|stale and STUB_METADATA=fail break a step.
// The script runs on the macOS lane, whose system bash is 3.2 (no `mapfile`), so
// there every case runs under /bin/bash; POOL_MAINTENANCE_TEST_BASH names a 3.2
// interpreter to do the same on another host.
const requestedBash =
  process.env.POOL_MAINTENANCE_TEST_BASH || (process.platform === "darwin" ? "/bin/bash" : "");

describe("measure.sh", () => {
  const tree = join(scratch, "measure");
  const stubs = join(scratch, "measure-stubs");
  const realJust = run("bash", ["-c", "command -v just"]).stdout.trim();
  mkdirSync(join(tree, "pool-maintenance"), { recursive: true });
  mkdirSync(stubs, { recursive: true });
  for (const file of ["measure.sh", "result.mjs", "budgets.yaml"]) {
    copyFileSync(join(root, "pool-maintenance", file), join(tree, "pool-maintenance", file));
  }
  chmodSync(join(tree, "pool-maintenance", "measure.sh"), 0o755);
  const stub = (name, body) => {
    writeFileSync(join(stubs, name), `#!/usr/bin/env bash\n${body}`);
    chmodSync(join(stubs, name), 0o755);
  };
  if (requestedBash) {
    writeFileSync(join(stubs, "bash"), `#!/bin/sh\nexec "${requestedBash}" "$@"\n`);
    chmodSync(join(stubs, "bash"), 0o755);
  }
  stub(
    "just",
    `exec "${realJust}" --justfile "${join(root, "justfile")}" --working-directory "$PWD" "$@"\n`,
  );
  stub(
    "cargo",
    `case "$1" in
  metadata)
    [[ "\${STUB_METADATA:-}" == fail ]] && { echo "error: stub metadata failure" >&2; exit 101; }
    echo '{"packages":[{"name":"demo"}]}' ;;
  llvm-cov)
    if [[ "\${CARGO_PROFILE_DEV_DEBUG_ASSERTIONS:-}" == false ]]; then
      [[ "\${STUB_ALT:-}" == none ]] && exit 0
      hash=00000000000000a1
    else
      [[ "\${STUB_ORDINARY:-}" == none ]] && exit 0
      hash=00000000000000b1
    fi
    mkdir -p "target/debug/.fingerprint/demo-$hash" target/debug/deps
    touch "target/debug/.fingerprint/demo-$hash/lib" "target/debug/deps/libdemo-$hash.rlib"
    if [[ "$hash" == 00000000000000b1 && "\${STUB_ORDINARY:-}" == stale ]]; then
      touch -t "$(node -e 'const d = new Date(Date.now() - 5 * 864e5), p = (n) => String(n).padStart(2, "0");
        console.log(\`\${d.getFullYear()}\${p(d.getMonth() + 1)}\${p(d.getDate())}\${p(d.getHours())}\${p(d.getMinutes())}\`)')" \\
        "target/debug/.fingerprint/demo-$hash/lib" \\
        "target/debug/.fingerprint/demo-$hash" "target/debug/deps/libdemo-$hash.rlib"
    fi ;;
  *) exit 64 ;;
esac
`,
  );

  function measure(env = {}, args = []) {
    rmSync(join(tree, "target"), { recursive: true, force: true });
    return run(
      join(root, "node_modules", ".bin", "onebudgetspec"),
      ["check", "--output", "json", ...args],
      {
        cwd: join(tree, "pool-maintenance"),
        env: {
          PATH: `${stubs}${delimiter}${process.env.PATH}`,
          HOME: process.env.HOME,
          ...env,
        },
      },
    );
  }
  const resultOf = (checked) => {
    const [result] = JSON.parse(checked.stdout).results;
    return result;
  };
  const deps = () => readdirSync(join(tree, "target", "debug", "deps")).sort();

  it("runs every case under the requested bash", {
    skip: !requestedBash && "no bash 3.2 requested on this host",
  }, () => {
    const version = run("bash", ["-c", 'echo "$BASH_VERSION"'], {
      env: { PATH: `${stubs}${delimiter}${process.env.PATH}` },
    });
    assert.match(version.stdout, /^3\.2\./, version.stderr);
  });

  it("reports the timed pass that removes the backdated alternative build", () => {
    const checked = measure();
    const result = resultOf(checked);
    // The check produced a figure rather than an error; whether that figure meets
    // the budget is the release-PR check's to say, never this test's.
    assert.notEqual(result.verdict, "error", checked.stdout);
    assert.equal(result.error ?? null, null, checked.stdout);
    assert.ok(Number.isFinite(result.actual) && result.actual >= 0, checked.stdout);
    assert.match(result.detail, /builds removed: 1;/);
    assert.match(result.detail, /alternative entries created: 2; entries removed: 2;/);
    assert.match(result.detail, /untimed backlog pass \(not in the figure\): [\d.e-]+ seconds$/);
    assert.deepEqual(deps(), ["libdemo-00000000000000b1.rlib"]);
  });

  it("fails when the alternative build creates nothing to supersede", () => {
    const result = resultOf(measure({ STUB_ALT: "none" }));
    assert.equal(result.verdict, "error");
    assert.match(result.error, /alternative build created no new entries/);
  });

  it("fails when the timed pass removes nothing", () => {
    const result = resultOf(measure({ STUB_ORDINARY: "none" }));
    assert.equal(result.verdict, "error");
    assert.match(result.error, /timed pass removed no entries/);
    assert.deepEqual(deps(), ["libdemo-00000000000000a1.rlib"]);
  });

  it("fails, naming them, when the timed pass removes ordinary entries", () => {
    const result = resultOf(measure({ STUB_ORDINARY: "stale" }));
    assert.equal(result.verdict, "error");
    assert.match(result.error, /removed entries the alternative build did not create/);
    assert.match(result.error, /libdemo-00000000000000b1\.rlib/);
  });

  it("fails, saying so, when the workspace crates cannot be listed", () => {
    const result = resultOf(measure({ STUB_METADATA: "fail" }));
    assert.equal(result.verdict, "error");
    assert.match(result.error, /could not list the workspace crates/);
    assert.doesNotMatch(result.error, /alternative build created no new entries/);
  });

  it("refuses a relative listing directory before building anything", () => {
    const result = resultOf(measure({ POOL_MAINTENANCE_WORK_DIR: "listings" }));
    assert.equal(result.verdict, "error");
    assert.match(result.error, /POOL_MAINTENANCE_WORK_DIR must be an absolute path/);
    assert.equal(existsSync(join(tree, "target")), false);
  });
});
