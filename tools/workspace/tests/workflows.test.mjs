// Workflow contract: the CI workflows, parsed, still report the fixed status
// contexts on every pull request, route the release PR to the full sweep and
// everything else to the affected tier, propagate a sweep failure to the `check`
// context, and keep the llmlint tier fail-fast. Step scripts are executed with
// synthetic event environments rather than inspected as text where it matters.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "../../..");
const workflow = (name) => parse(readFileSync(join(root, ".github/workflows", name), "utf8"));
const check = workflow("check.yml");
// A GitHub Actions expression, spelled out without a template-literal look-alike.
const expr = (body) => ["$", "{{ ", body, " }}"].join("");

// The contexts branch protection keys on (the fixed context contract): the
// workflow file, the job id, and the context name that job reports.
const CONTRACT = [
  { file: "check.yml", job: "check-required", context: "check" },
  { file: "check.yml", job: "install-smoke", context: "install-smoke" },
  { file: "pr-title.yml", job: "pr-title", context: "pr-title" },
  { file: "visual-docs.yml", job: "visual-docs", context: "visual-docs / capture (x86_64)" },
];

function runScript(script, env, cwd = root) {
  return spawnSync("bash", ["-eo", "pipefail", "-c", script], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
  });
}

function step(job, predicate) {
  const found = job.steps.find(predicate);
  assert.ok(found, "step not found");
  return found;
}

function pickTier(env) {
  const dir = mkdtempSync(join(tmpdir(), "gh-output-"));
  try {
    const output = join(dir, "out");
    writeFileSync(output, "");
    const pick = step(check.jobs.setup, (s) => s.id === "pick");
    const run = runScript(pick.run, { ...env, GITHUB_OUTPUT: output });
    assert.equal(run.status, 0, run.stderr);
    return Object.fromEntries(
      readFileSync(output, "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split(/=(.*)/s).slice(0, 2)),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const RELEASE_BRANCH = "release-please--branches--main--components--allowlister-remote-plugin";

describe("check.yml gate routing", () => {
  it("runs the full sweep on release-please's release PR", () => {
    const out = pickTier({ EVENT_NAME: "pull_request", HEAD_REF: RELEASE_BRANCH });
    assert.equal(out.tier, "all");
    assert.equal(out.os, '["ubuntu-latest"]');
  });

  it("runs the affected tier on an ordinary PR, even one naming the release branch", () => {
    for (const head of ["feature/x", `chore/${RELEASE_BRANCH}`]) {
      assert.equal(pickTier({ EVENT_NAME: "pull_request", HEAD_REF: head }).tier, "affected");
    }
  });

  it("runs the affected tier on a push to main, across the OS matrix", () => {
    const out = pickTier({ EVENT_NAME: "push", HEAD_REF: "" });
    assert.equal(out.tier, "affected");
    assert.equal(out.os, '["ubuntu-latest","macos-14","windows-latest"]');
  });

  it("hands the tier to `just check`, which maps it to run-many or affected", () => {
    const gate = step(check.jobs.check, (s) => s.run?.includes("just check"));
    assert.equal(gate.env.TIER, expr("needs.setup.outputs.tier"));
    const dir = mkdtempSync(join(tmpdir(), "just-stub-"));
    try {
      // A stub `just` records the recipe the step invokes.
      const stub = join(dir, "just");
      writeFileSync(stub, `#!/usr/bin/env bash\necho "$*" > "${join(dir, "args")}"\n`);
      chmodSync(stub, 0o755);
      const run = runScript(gate.run, {
        TIER: "all",
        PATH: `${dir}${delimiter}${process.env.PATH}`,
      });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(readFileSync(join(dir, "args"), "utf8").trim(), "check all");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // Pin NX_BASE/NX_HEAD per case: CI exports both, and the recipe's affected
    // command differs by which are set, so an inherited environment must not pick
    // the form under test.
    const dryRun = (env, ...args) => {
      const { NX_BASE: _b, NX_HEAD: _h, ...rest } = process.env;
      return spawnSync("just", ["-n", ...args], {
        cwd: root,
        encoding: "utf8",
        env: { ...rest, ...env },
      });
    };
    const sweep = /just test all\n.*npx nx run-many -t fmt-check lint lint-compiler typecheck/s;
    assert.match(dryRun({}, "check", "all").stderr, sweep);
    assert.match(dryRun({}, "test", "all").stderr, /npx nx run-many -t test coverage/);
    const BASE = "a50681a1b06c0000000000000000000000000000";
    const HEAD = "796a72db60c20000000000000000000000000000";
    // Every form the recipe produces: local default (origin/main), CI push/PR
    // with a base only, and a PR with both a base and a head commit.
    for (const [env, flags] of [
      [{}, "--base=origin/main"],
      [{ NX_BASE: BASE }, `--base=${BASE}`],
      [{ NX_BASE: BASE, NX_HEAD: HEAD }, `--base=${BASE} --head=${HEAD}`],
    ]) {
      const affected = `npx nx affected ${flags} -t`;
      const checkOut = dryRun(env, "check", "affected");
      assert.equal(checkOut.status, 0, checkOut.stderr);
      assert.match(checkOut.stderr, /just test affected\n/);
      assert.ok(
        checkOut.stderr.includes(
          `${affected} fmt-check lint lint-compiler typecheck build supply-chain test-e2e`,
        ),
        checkOut.stderr,
      );
      assert.ok(dryRun(env, "test", "affected").stderr.includes(`${affected} test coverage`));
    }
    assert.notEqual(dryRun({ NX_HEAD: "bad;ref" }, "check", "affected").status, 0);
    assert.notEqual(dryRun({}, "check", "bogus").status, 0);
  });

  it("fails the `check` context when any matrix leg (the sweep included) fails", () => {
    const aggregate = check.jobs["check-required"];
    assert.equal(aggregate.name, "check");
    assert.equal(aggregate.needs, "check");
    assert.equal(aggregate.if, "always()");
    const verify = aggregate.steps[0];
    for (const [result, ok] of [
      ["success", true],
      ["failure", false],
      ["cancelled", false],
      ["skipped", false],
    ]) {
      assert.equal(runScript(verify.run, { CHECK_RESULT: result }).status === 0, ok, result);
    }
  });
});

describe("check.yml hygiene", () => {
  it("declares least-privilege top-level permissions", () => {
    assert.deepEqual(check.permissions, { contents: "read" });
  });

  it("passes event fields into shell steps only through env", () => {
    for (const [id, job] of Object.entries(check.jobs)) {
      for (const s of job.steps ?? []) {
        if (s.run) assert.doesNotMatch(s.run, /\$\{\{/, `${id}: interpolation in run:`);
      }
    }
    const base = step(check.jobs.check, (s) => s.name === "Resolve affected base");
    assert.equal(base.env.PR_BASE_SHA, expr("github.event.pull_request.base.sha"));
    assert.equal(base.env.PUSH_BEFORE_SHA, expr("github.event.before"));
  });

  it("derives the PR base explicitly from the event", () => {
    const base = step(check.jobs.check, (s) => s.name === "Resolve affected base");
    const dir = mkdtempSync(join(tmpdir(), "gh-env-"));
    try {
      const envFile = join(dir, "env");
      writeFileSync(envFile, "");
      const run = runScript(base.run, {
        EVENT_NAME: "pull_request",
        PR_BASE_SHA: "abc123",
        HEAD_SHA: "def456",
        GITHUB_ENV: envFile,
      });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(readFileSync(envFile, "utf8"), "NX_BASE=abc123\nNX_HEAD=def456\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// A job is reported on every PR when its workflow triggers on pull_request
// without a path filter and neither it nor anything it needs is conditional.
function reportedOnEveryPullRequest(file, jobId) {
  const wf = workflow(file);
  const trigger = wf.on.pull_request ?? {};
  for (const filter of ["paths", "paths-ignore", "branches-ignore"]) {
    assert.equal(trigger?.[filter], undefined, `${file}: pull_request.${filter}`);
  }
  if (trigger?.branches) assert.ok(trigger.branches.includes("main"), `${file}: branches`);
  const seen = new Set();
  const visit = (id, isRoot) => {
    if (seen.has(id)) return;
    seen.add(id);
    const job = wf.jobs[id];
    assert.ok(job, `${file}: job ${id} missing`);
    if (job.if !== undefined) {
      assert.ok(isRoot && job.if === "always()", `${file}: ${id} has if: ${job.if}`);
    }
    for (const need of [job.needs ?? []].flat()) visit(need, false);
  };
  visit(jobId, true);
  return wf.jobs[jobId];
}

describe("fixed status-check contexts", () => {
  for (const { file, job, context } of CONTRACT) {
    it(`${context} is reported on every pull request`, () => {
      const definition = reportedOnEveryPullRequest(file, job);
      if (file === "visual-docs.yml") {
        // The reusable workflow's `capture` job (per arch) reports under this caller.
        assert.match(definition.uses, /^nickderobertis\/screencomp\/\.github\/workflows\//);
        assert.equal(`${job} / capture (x86_64)`, context);
      } else {
        assert.equal(definition.name ?? job, context);
      }
    });
  }
});

describe("visual-docs lanes", () => {
  it("every [capture].arches entry has a committed baseline, x86_64 and arm64 among them", () => {
    const toml = readFileSync(join(root, "screencomp.toml"), "utf8");
    const arches = JSON.parse(toml.match(/^arches\s*=\s*(\[.*\])\s*$/m)[1]);
    assert.deepEqual(arches, ["x86_64", "arm64"]);
    for (const arch of arches) {
      const manifest = JSON.parse(readFileSync(join(root, `shots/baseline/${arch}.json`), "utf8"));
      assert.ok(manifest.shots.length > 0, `${arch} baseline is empty`);
    }
  });
});

describe("llmlint.yml", () => {
  const llmlint = workflow("llmlint.yml");
  const job = llmlint.jobs.llmlint;

  it("is the `llmlint` context on pull requests, reading codex's OPENAI_API_KEY", () => {
    assert.ok("pull_request" in llmlint.on);
    assert.equal(job.name ?? "llmlint", "llmlint");
    assert.equal(job.env.OPENAI_API_KEY, expr("secrets.OPENAI_API_KEY"));
    assert.equal(job.if, undefined);
  });

  it("fails fast, naming the secret, when the credential is absent", () => {
    const first = job.steps[0];
    const missing = runScript(first.run, { OPENAI_API_KEY: "" });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /OPENAI_API_KEY/);
    assert.equal(runScript(first.run, { OPENAI_API_KEY: "sk-test" }).status, 0);
  });

  it("installs codex, validates against origin/main, then lints the diff", () => {
    const runs = job.steps.map((s) => s.run ?? "");
    const at = (pattern) => runs.findIndex((run) => pattern.test(run));
    const install = at(/npm install --global @openai\/codex/);
    const validate = at(/just lint-llm-validate --diff-base origin\/main/);
    const diff = at(/just lint-llm-diff origin\/main/);
    assert.ok(install > 0 && validate > install && diff > validate, JSON.stringify(runs));
    assert.ok(!job.steps.some((s) => s.if), "no step may skip the judged lint");
  });
});

describe("notignored.yml", () => {
  const notignored = workflow("notignored.yml");

  it("comments on same-repo pull requests with least privilege, outside the contract", () => {
    assert.ok("pull_request" in notignored.on);
    assert.deepEqual(notignored.permissions, { contents: "read", "pull-requests": "write" });
    const [id, job] = Object.entries(notignored.jobs)[0];
    assert.match(job.if, /head\.repo\.full_name == github\.repository/);
    assert.ok(job.steps.some((s) => s.uses === "nickderobertis/notignored@v0"));
    const contexts = CONTRACT.map((c) => c.context);
    assert.ok(!contexts.includes(job.name ?? id));
  });
});

describe("rust-toolchain.toml", () => {
  it("installs exactly the targets publish.yml builds release binaries for", () => {
    const toolchain = readFileSync(join(root, "rust-toolchain.toml"), "utf8");
    const line = toolchain.match(/^targets\s*=\s*\[([^\]]*)\]/m);
    assert.ok(line, "rust-toolchain.toml declares no targets");
    const pinned = [...line[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort();
    const matrix = workflow("publish.yml").jobs["build-binary"].strategy.matrix.include;
    assert.deepEqual(pinned, matrix.map((leg) => leg.target).sort());
  });
});
