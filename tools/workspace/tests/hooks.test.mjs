// The developer hooks, run for real in scratch copies: the SessionStart hook
// hands off to setup-llmlint.sh on every path it can exit by and returns at once
// with exit 0 however that setup goes, and the pre-push hook runs llmlint's
// validate step — blocking on a failure, skipping when llmlint is absent.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { after, describe, it } from "node:test";

const root = resolve(import.meta.dirname, "../../..");
const scratchDirs = [];
const startedPids = [];
after(() => {
  for (const pid of startedPids) {
    try {
      process.kill(pid);
    } catch {
      // already exited
    }
  }
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "hooks-"));
  scratchDirs.push(dir);
  return dir;
}

function writeExecutable(path, body) {
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

// PATH entries from this process minus any directory holding one of `hidden`.
function pathWithout(hidden) {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => dir && !hidden.some((tool) => existsSync(join(dir, tool))));
}

// A directory of symlinks to just the named tools, for a PATH that lacks the rest.
function curatedBin(dir, tools) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  for (const tool of tools) {
    const found = spawnSync("bash", ["-c", `command -v ${tool}`], {
      encoding: "utf8",
    }).stdout.trim();
    if (found) symlinkSync(found, join(bin, tool));
  }
  return bin;
}

const CORE = ["bash", "mkdir", "dirname", "cat", "touch", "sleep", "sha256sum", "awk", "env"];

// A copy of the session hook beside a stand-in setup.sh and setup-llmlint.sh.
function sessionRepo(llmlintBody, setupExit = 0) {
  const dir = scratch();
  mkdirSync(join(dir, "scripts"));
  mkdirSync(join(dir, "home"));
  for (const file of ["session-setup.sh", "setup-lib.sh"]) {
    copyFileSync(join(root, "scripts", file), join(dir, "scripts", file));
  }
  writeExecutable(join(dir, "scripts/setup.sh"), `exit ${setupExit}`);
  const marker = join(dir, "llmlint-ran");
  writeExecutable(
    join(dir, "scripts/setup-llmlint.sh"),
    `echo $$ > "${marker}.pid"\ntouch "${marker}"\n${llmlintBody}`,
  );
  return { dir, marker };
}

function runSessionHook(dir, env, path = process.env.PATH) {
  const started = Date.now();
  const run = spawnSync("bash", [join(dir, "scripts/session-setup.sh")], {
    cwd: dir,
    encoding: "utf8",
    timeout: 20_000,
    env: { PATH: path, HOME: join(dir, "home"), CLAUDE_PROJECT_DIR: dir, ...env },
  });
  return { ...run, elapsed: Date.now() - started };
}

function waitFor(file, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (existsSync(file)) return true;
    spawnSync("sleep", ["0.1"]);
  }
  return false;
}

describe("SessionStart hook hands off to setup-llmlint.sh", () => {
  const paths = {
    "CI (GITHUB_ACTIONS)": { env: { GITHUB_ACTIONS: "true" } },
    "escape hatch (ALLOWLISTER_SKIP_SETUP)": { env: { ALLOWLISTER_SKIP_SETUP: "1" } },
    "remote, setup succeeds": { env: { CLAUDE_CODE_REMOTE: "true" } },
    "remote, setup fails": { env: { CLAUDE_CODE_REMOTE: "true" }, setupExit: 1 },
    "opt-in background setup": { env: { ALLOWLISTER_AUTO_SETUP: "1" } },
    "default advice": { env: {} },
  };
  for (const [name, { env, setupExit }] of Object.entries(paths)) {
    it(`on the ${name} path`, () => {
      const { dir, marker } = sessionRepo("exit 0", setupExit);
      const run = runSessionHook(dir, env);
      assert.equal(run.status, 0, run.stderr);
      assert.ok(waitFor(marker), `setup-llmlint.sh never ran (${name})`);
    });
  }

  it("on the ready path (setup stamp current)", () => {
    const { dir, marker } = sessionRepo("exit 0");
    const stamp = spawnSync("bash", ["-c", ". scripts/setup-lib.sh; _write_stamp"], { cwd: dir });
    assert.equal(stamp.status, 0);
    const run = runSessionHook(dir, {});
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, "", "a ready environment stays silent");
    assert.ok(waitFor(marker));
  });

  for (const [name, body] of [
    ["fails", "exit 1"],
    ["needs a tool missing from PATH", "definitely-not-an-installed-tool --version"],
  ]) {
    it(`returns 0 when setup-llmlint.sh ${name}`, () => {
      const { dir, marker } = sessionRepo(body);
      const run = runSessionHook(dir, {});
      assert.equal(run.status, 0, run.stderr);
      assert.ok(waitFor(marker));
    });
  }

  it("returns promptly while a slow setup-llmlint.sh is still running", () => {
    const { dir, marker } = sessionRepo("exec sleep 30");
    const run = runSessionHook(dir, {});
    assert.equal(run.status, 0, run.stderr);
    assert.ok(run.elapsed < 5_000, `hook took ${run.elapsed}ms`);
    assert.ok(waitFor(`${marker}.pid`));
    startedPids.push(Number(readFileSync(`${marker}.pid`, "utf8")));
  });

  it("the real setup-llmlint.sh exits cleanly when uv is missing from PATH", () => {
    const { dir } = sessionRepo("");
    copyFileSync(join(root, "scripts/setup-llmlint.sh"), join(dir, "scripts/setup-llmlint.sh"));
    // Only the coreutils the hook needs — no uv, llmlint, node, cargo or just.
    const bin = curatedBin(dir, [...CORE, "setsid", "nohup", "flock"]);
    const run = runSessionHook(dir, {}, bin);
    assert.equal(run.status, 0, run.stderr);
    const log = join(dir, ".dev/setup-llmlint.log");
    assert.ok(waitFor(log));
    const deadline = Date.now() + 10_000;
    while (!readFileSync(log, "utf8").includes("uv not found") && Date.now() < deadline) {
      spawnSync("sleep", ["0.1"]);
    }
    assert.match(readFileSync(log, "utf8"), /uv not found; cannot install llmlint/);
  });

  it("goes through `just setup-llmlint` when just and the justfile are present", () => {
    const { dir, marker } = sessionRepo("exit 0");
    writeFileSync(join(dir, "justfile"), `setup-llmlint:\n    touch "${dir}/just-ran"\n`);
    const run = runSessionHook(dir, {});
    assert.equal(run.status, 0, run.stderr);
    assert.ok(waitFor(join(dir, "just-ran")), "the just recipe never ran");
    assert.ok(!existsSync(marker), "the script ran directly despite just");
  });

  it("falls back to nohup without setsid, and runs without flock", () => {
    const { dir, marker } = sessionRepo("exit 0");
    const run = runSessionHook(dir, {}, curatedBin(dir, [...CORE, "nohup"]));
    assert.equal(run.status, 0, run.stderr);
    assert.ok(waitFor(marker));
  });

  it("skips the hand-off, still exiting 0, when no launcher is available", () => {
    const { dir, marker } = sessionRepo("exit 0");
    const run = runSessionHook(dir, {}, curatedBin(dir, CORE));
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /neither setsid nor nohup is on PATH; run `just setup-llmlint`/);
    assert.ok(!waitFor(marker, 1_000));
  });

  it("exits 0 when the installer is absent or .dev cannot be created", () => {
    const absent = sessionRepo("exit 0");
    rmSync(join(absent.dir, "scripts/setup-llmlint.sh"));
    assert.equal(runSessionHook(absent.dir, {}).status, 0);
    const blocked = sessionRepo("exit 0");
    writeFileSync(join(blocked.dir, ".dev"), "a file, not a directory");
    const run = runSessionHook(blocked.dir, {});
    assert.equal(run.status, 0);
    assert.match(run.stderr, /cannot create .*\.dev; fix that path or run `just setup-llmlint`/);
    assert.ok(!waitFor(blocked.marker, 1_000));
  });

  it("runs one install when two sessions start at once (flock)", () => {
    const { dir } = sessionRepo('echo run >> "$(dirname "$0")/../runs"\nsleep 2');
    assert.equal(runSessionHook(dir, {}).status, 0);
    assert.equal(runSessionHook(dir, {}).status, 0);
    assert.ok(waitFor(join(dir, "runs")));
    spawnSync("sleep", ["2.5"]);
    assert.equal(readFileSync(join(dir, "runs"), "utf8"), "run\n");
  });

  it("installs llmlint-cli at the 0.3.23 floor through uv", () => {
    const dir = scratch();
    mkdirSync(join(dir, "home"));
    const bin = curatedBin(dir, CORE);
    // A stand-in uv records the install it is asked for.
    writeExecutable(join(bin, "uv"), `echo "$*" >> "${dir}/uv-args"`);
    const run = spawnSync("bash", [join(root, "scripts/setup-llmlint.sh")], {
      encoding: "utf8",
      env: { PATH: bin, HOME: join(dir, "home") },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(
      readFileSync(join(dir, "uv-args"), "utf8"),
      "tool install --upgrade llmlint-cli>=0.3.23\n",
    );
    assert.match(run.stderr, /llmlint not installed/);
  });

  it("finds the repository from its own path when CLAUDE_PROJECT_DIR is unset", () => {
    const { dir, marker } = sessionRepo("exit 0");
    const run = spawnSync("bash", [join(dir, "scripts/session-setup.sh")], {
      cwd: tmpdir(),
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: join(dir, "home") },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.ok(waitFor(marker));
  });

  it("falls back to the script when `just setup-llmlint` fails", () => {
    const { dir, marker } = sessionRepo("exit 0");
    writeFileSync(join(dir, "justfile"), "setup-llmlint:\n    exit 3\n");
    assert.equal(runSessionHook(dir, {}).status, 0);
    assert.ok(waitFor(marker));
    assert.match(
      readFileSync(join(dir, ".dev/setup-llmlint.log"), "utf8"),
      /just setup-llmlint failed/,
    );
  });

  it("runs without the lock when the lock file cannot be opened", {
    skip: process.getuid?.() === 0,
  }, () => {
    const { dir, marker } = sessionRepo("exit 0");
    mkdirSync(join(dir, ".dev"));
    writeFileSync(join(dir, ".dev/setup-llmlint.lock"), "");
    chmodSync(join(dir, ".dev/setup-llmlint.lock"), 0o000);
    assert.equal(runSessionHook(dir, {}).status, 0);
    assert.ok(waitFor(marker));
    assert.match(
      readFileSync(join(dir, ".dev/setup-llmlint.log"), "utf8"),
      /running without the concurrency lock/,
    );
  });

  it("still exits 0 when the launcher itself fails, leaving its error in the log", () => {
    const { dir, marker } = sessionRepo("exit 0");
    const bin = curatedBin(dir, [...CORE, "flock"]);
    writeExecutable(join(bin, "setsid"), 'echo "setsid: cannot start" >&2\nexit 1');
    assert.equal(runSessionHook(dir, {}, bin).status, 0);
    assert.ok(waitFor(join(dir, ".dev/setup-llmlint.log")));
    spawnSync("sleep", ["0.5"]);
    const log = readFileSync(join(dir, ".dev/setup-llmlint.log"), "utf8");
    assert.match(log, /setsid: cannot start/);
    assert.match(log, /llmlint setup via setsid exited 1; run `just setup-llmlint`/);
    assert.ok(!existsSync(marker));
  });
});

describe("pre-push hook runs llmlint validate", () => {
  function prePush({ llmlint, config }) {
    const dir = scratch();
    const stubs = join(dir, "stubs");
    mkdirSync(stubs);
    // The React Compiler lint is out of scope here; stub npx to pass.
    writeExecutable(join(stubs, "npx"), "exit 0");
    if (llmlint) {
      writeExecutable(
        join(stubs, "llmlint"),
        `[ "$1" = validate ] || exit 2\ngrep -q INVALID llmlint.yml && { echo "llmlint: config invalid" >&2; exit 1; }\necho "llmlint: static checks passed"`,
      );
    }
    writeFileSync(join(dir, "llmlint.yml"), config);
    const path = [stubs, ...pathWithout(["llmlint", "screencomp"])].join(delimiter);
    return spawnSync("bash", [join(root, ".githooks/pre-push")], {
      cwd: dir,
      encoding: "utf8",
      input: "",
      env: { PATH: path, HOME: process.env.HOME },
    });
  }

  it("passes a valid config", () => {
    const run = prePush({ llmlint: true, config: "plugins: []\n" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /static checks passed/);
  });

  it("blocks the push on an invalid config", () => {
    const run = prePush({ llmlint: true, config: "INVALID\n" });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /pre-push: llmlint validate failed/);
  });

  it("skips without blocking when llmlint is not installed", () => {
    const run = prePush({ llmlint: false, config: "INVALID\n" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /llmlint not on PATH; skipping llmlint validate/);
  });
});
