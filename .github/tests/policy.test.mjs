import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  root,
  load,
  workflows,
  triggered,
  resolveRun,
  sourceDigest,
  evaluate,
} from "../workflow-graph.mjs";
const scratchRoot = process.env.ONEPIPELINE_NODE_SCRATCH_DIR ?? join(root, ".github/.telemetry");
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, "policy-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const git = (...args) => execFileSync("git", args, { cwd: scratch, encoding: "utf8" }).trim();
git("init", "-q");
git("config", "user.email", "test@example.com");
git("config", "user.name", "Policy test");
const write = (path, value) =>
  writeFileSync(join(scratch, path), typeof value === "string" ? value : JSON.stringify(value));
write("package.json", {
  name: "example",
  version: "0.1.0",
  dependencies: { library: "1.0.0" },
  workspaces: ["apps/web"],
});
mkdirSync(join(scratch, "apps/web"), { recursive: true });
write("apps/web/package.json", { name: "web", version: "0.1.0", scripts: { build: "next build" } });
write("package-lock.json", {
  name: "example",
  version: "0.1.0",
  lockfileVersion: 3,
  packages: {
    "": { name: "example", version: "0.1.0" },
    "apps/web": { name: "web", version: "0.1.0" },
    "node_modules/library": { version: "1.0.0", integrity: "abc" },
    "node_modules/web": {
      name: "web",
      version: "0.1.0",
      resolved: "https://registry.npmjs.org/web/-/web-0.1.0.tgz",
    },
  },
});
write(".release-please-manifest.json", { ".": "0.1.0" });
write("CHANGELOG.md", "# Changelog\n\n## 0.1.0\n\nInitial\n");
write("source.js", "old\n");
git("add", ".");
git("commit", "-qm", "base");
const base = git("rev-parse", "HEAD");
const heads = {};
for (const diff of [
  "source",
  "version",
  "dependency",
  "mixed",
  "lock-version",
  "lock-dependency",
  "lock-same-named-registry",
  "manifest-version",
  "malformed",
  "empty",
  "added",
  "deleted",
  "invalid-changelog",
  "nested-version",
  "nested-content",
  "lock-nested",
]) {
  git("checkout", "-q", base);
  if (["version", "mixed"].includes(diff)) {
    write(".release-please-manifest.json", { ".": "0.2.0" });
    write("CHANGELOG.md", "# Changelog\n\n## 0.2.0\n\nChanges\n\n## 0.1.0\nInitial\n");
  }
  if (["source", "mixed"].includes(diff)) write("source.js", "new\n");
  if (diff === "manifest-version")
    write("package.json", {
      name: "example",
      version: "0.2.0",
      dependencies: { library: "1.0.0" },
      workspaces: ["apps/web"],
    });
  if (diff === "dependency")
    write("package.json", {
      name: "example",
      version: "0.2.0",
      dependencies: { library: "2.0.0" },
      workspaces: ["apps/web"],
    });
  if (diff.startsWith("lock-")) {
    const lock = JSON.parse(readFileSync(join(scratch, "package-lock.json")));
    lock.version = "0.2.0";
    lock.packages[""].version = "0.2.0";
    if (diff === "lock-dependency") lock.packages["node_modules/library"].version = "2.0.0";
    if (diff === "lock-same-named-registry") lock.packages["node_modules/web"].version = "0.2.0";
    write("package-lock.json", lock);
  }
  if (diff === "added") write("extra.txt", "extra");
  if (diff === "deleted") rmSync(join(scratch, "source.js"));
  if (diff === "invalid-changelog") write("CHANGELOG.md", "not a changelog");
  if (diff === "nested-version" || diff === "nested-content")
    write("apps/web/package.json", {
      name: "web",
      version: "0.2.0",
      scripts: { build: diff === "nested-content" ? "different" : "next build" },
    });
  if (diff === "lock-nested") {
    const lock = JSON.parse(readFileSync(join(scratch, "package-lock.json")));
    lock.packages["apps/web"].version = "0.2.0";
    write("package-lock.json", lock);
  }
  if (diff === "malformed") write("package.json", "{");
  git("add", ".");
  git("commit", "--allow-empty", "-qm", diff);
  heads[diff] = git("rev-parse", "HEAD");
}
export function prEvent(diff = "source", fork = false, release = false) {
  const repo = "nickderobertis/allowlister-remote";
  return {
    repository: { full_name: repo },
    pull_request: {
      title: "chore(main): release",
      user: { login: "nickderobertis" },
      base: { sha: base, ref: "main", repo: { full_name: repo } },
      head: {
        sha: heads[diff],
        ref: release ? "release-please--branches--main" : "feature/work",
        repo: { full_name: fork ? "fork/allowlister-remote" : repo },
      },
    },
  };
}
function classify(event, head, name = "pull_request", output = "") {
  const path = join(scratch, "event.json");
  writeFileSync(path, typeof event === "string" ? event : JSON.stringify(event));
  const run = spawnSync(
    "node",
    [
      join(root, ".github/macos-policy.mjs"),
      "classify",
      "--event",
      path,
      "--base",
      base,
      "--head",
      head,
    ],
    {
      cwd: scratch,
      encoding: "utf8",
      env: { ...process.env, GITHUB_EVENT_NAME: name, GITHUB_OUTPUT: output },
    },
  );
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}
const routes = new Map();
function route(scenario) {
  const key = JSON.stringify([scenario.eventName, scenario.event]);
  if (routes.has(key)) return routes.get(key);
  const policy = classify(
    scenario.event,
    scenario.event.pull_request?.head?.sha,
    scenario.eventName,
  );
  const output = join(scratch, "output");
  writeFileSync(output, "");
  const script = load(".github/workflows/check.yml").jobs.setup.steps.find(
    (step) => step.id === "pick",
  ).run;
  const run = spawnSync("bash", ["-e", "-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      EVENT_NAME: scenario.eventName,
      HEAD_REF: scenario.event.pull_request?.head?.ref ?? "",
      MACOS_REQUIRED: String(policy.macosRequired),
      DIAGNOSTIC: String(scenario.event.inputs?.macos ?? false),
      GITHUB_OUTPUT: output,
    },
  });
  assert.equal(run.status, 0, run.stderr);
  const result = {
    ...Object.fromEntries(
      readFileSync(output, "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split(/=(.*)/s).slice(0, 2)),
    ),
    macosRequired: String(policy.macosRequired),
  };
  routes.set(key, result);
  return result;
}
test("real classifier over git histories: automation branch and semantic diff, never identity/title alone", () => {
  for (const diff of Object.keys(heads))
    for (const fork of [false, true])
      for (const release of [false, true]) {
        const result = classify(prEvent(diff, fork, release), heads[diff]);
        assert.equal(
          result.isReleaseOnly,
          !fork &&
            release &&
            [
              "version",
              "lock-version",
              "manifest-version",
              "nested-version",
              "lock-nested",
            ].includes(diff),
          `${diff} fork=${fork} branch=${release}`,
        );
        assert.equal(result.macosRequired, !result.isReleaseOnly);
      }
  const output = join(scratch, "classifier-output");
  writeFileSync(output, "");
  const release = classify(prEvent("version", false, true), heads.version, "pull_request", output);
  assert.equal(
    readFileSync(output, "utf8"),
    `macosRequired=${release.macosRequired}\nisReleaseOnly=${release.isReleaseOnly}\n`,
  );
  assert.equal(classify("{", "bad", "typo").macosRequired, true);
  const emptyRepo = prEvent("version", false, true);
  emptyRepo.repository.full_name = "";
  emptyRepo.pull_request.base.repo.full_name = "";
  emptyRepo.pull_request.head.repo.full_name = "";
  assert.equal(classify(emptyRepo, heads.version).macosRequired, true);
  const arrayRef = prEvent("version", false, true);
  arrayRef.pull_request.head.ref = [arrayRef.pull_request.head.ref];
  assert.equal(classify(arrayRef, heads.version).macosRequired, true);
  const bot = prEvent("version");
  bot.pull_request.user.login = "github-actions[bot]";
  assert.equal(classify(bot, heads.version).macosRequired, true);
  for (const event of ["{", {}, prEvent("version", false, true)])
    assert.equal(classify(event, "missing-ref").macosRequired, true);
  for (const name of [
    "push",
    "release",
    "workflow_run",
    "repository_dispatch",
    "schedule",
    "workflow_dispatch",
  ])
    assert.equal(classify("{", "bad", name).macosRequired, false);
});
const arches = JSON.parse(
  readFileSync(join(root, "screencomp.toml"), "utf8").match(/^arches\s*=\s*(\[.*\])/m)[1],
);
function outputFor(file, id, scenario) {
  if (file.endsWith("/check.yml") && id === "setup") return route(scenario);
  if (file.endsWith("/bench.yml") && id === "changes")
    return { plugin: "true", daemon: "true", broker: "true", web: "true" };
  if (file.endsWith("/visual-docs-reusable.yml") && id === "arches")
    return { matrix: JSON.stringify(arches) };
  const job = load(file).jobs[id];
  if (job.outputs) throw new Error(`Unresolved job outputs ${file}/${id}`);
  return {};
}
function runs(scenario) {
  return workflows()
    .filter(({ workflow }) => triggered(workflow, scenario))
    .map(({ file, workflow }) => ({
      workflow: file,
      scenario: scenario.id,
      rows: resolveRun(
        file,
        workflow,
        scenario,
        outputFor,
        Object.fromEntries(
          Object.entries(workflow.on.workflow_dispatch?.inputs ?? {}).map(([key, definition]) => [
            key,
            scenario.event.inputs?.[key] ?? definition.default,
          ]),
        ),
      ),
    }));
}
const scenario = (id, eventName, event = {}, ref = "refs/heads/main") => ({
  id,
  eventName,
  event,
  ref,
});
const events = [
  ["pr-opened", "pull_request", "opened"],
  ["pr-synchronize", "pull_request", "synchronize"],
  ["pr-reopened", "pull_request", "reopened"],
  ["base-push", "push"],
  ["release-merge", "push"],
  ["tag-push", "push", null, "refs/tags/v0.2.0"],
  ["release-published", "release", "published"],
  ["downstream", "workflow_run"],
  ["dispatch", "repository_dispatch"],
  ["schedule", "schedule"],
  ["manual-default", "workflow_dispatch"],
  ["manual-opt-in", "workflow_dispatch"],
];
const recorded = [],
  lifecycles = [];
test("actual workflow graph, reusable call and event fan-out record telemetry", () => {
  for (const diff of ["source", "version", "dependency"])
    for (const fork of [false, true])
      for (const publish of [false, true])
        for (const pages of [false, true]) {
          for (const [id, name, action, ref] of events) {
            const event =
              name === "pull_request"
                ? { ...prEvent(diff, fork, diff === "version"), action }
                : name === "workflow_run"
                  ? {
                      workflow_run: {
                        name: "publish",
                        conclusion: "success",
                        head_branch: "v0.2.0",
                        event: "push",
                      },
                      action: "completed",
                    }
                  : { action, inputs: { macos: id === "manual-opt-in" } };
            const current = {
              ...scenario(`${id}/${diff}/${fork}/${publish}/${pages}`, name, event, ref),
              optionalPublish: { publish, pages },
            };
            const resolved = runs(current);
            recorded.push(...resolved);
            const hasMac = resolved.flatMap((run) => run.rows).some((row) => row.macos);
            const expectedMac =
              name === "pull_request"
                ? !(diff === "version" && !fork)
                : id === "tag-push" || id === "manual-opt-in";
            assert.equal(hasMac, expectedMac, current.id);

            for (const run of resolved)
              for (const row of run.rows.filter((row) => row.macos)) {
                assert.ok(
                  (name === "pull_request" && !(diff === "version" && !fork)) ||
                    (name === "push" && ref?.startsWith("refs/tags/")) ||
                    id === "manual-opt-in",
                  JSON.stringify(row),
                );
                assert.ok(row.job === "check" || row.job === "build-binary", JSON.stringify(row));
              }
            if (name === "pull_request") {
              const names = resolved.flatMap((run) => run.rows.map((row) => row.display));
              for (const required of [
                "check",
                "install-smoke",
                "llmlint",
                "pr-title",
                ...arches.map((arch) => `visual-docs / capture (${arch})`),
              ])
                assert.equal(names.filter((name) => name === required).length, 1, required);
            }
          }
          for (const releaseDiff of ["source", "dependency", "mixed"]) {
            const forged = scenario(`forged-release/${releaseDiff}/${fork}`, "pull_request", {
              ...prEvent(releaseDiff, fork, true),
              action: "synchronize",
            });
            const resolved = runs(forged);
            recorded.push(...resolved);
            assert.ok(
              resolved.flatMap((run) => run.rows).some((row) => row.macos),
              forged.id,
            );
          }
          recorded.push(...runs(scenario("master-push", "push", {}, "refs/heads/master")));
          const unknown = {
            ...scenario("unknown-pr", "pull_request", { action: "synchronize" }),
            optionalPublish: { publish, pages },
          };
          const unknownRuns = runs(unknown);
          recorded.push(...unknownRuns);
          assert.ok(unknownRuns.flatMap((run) => run.rows).some((row) => row.macos));
          const stages = [
            scenario("ordinary-pr", "pull_request", {
              ...prEvent(diff, fork),
              action: "synchronize",
            }),
            scenario("base-merge", "push"),
            scenario("ordinary-pr-closed", "pull_request", {
              ...prEvent(diff, fork),
              action: "closed",
            }),
            scenario("release-pr", "pull_request", {
              ...prEvent("version", false, true),
              action: "synchronize",
            }),
            scenario("release-pr-merge", "push"),
            scenario("release-pr-closed", "pull_request", {
              ...prEvent("version", false, true),
              action: "closed",
            }),
            scenario("release-build", "push", {}, "refs/tags/v0.2.0"),
            scenario("release-published", "release", { action: "published" }),
          ];
          const lifecycleRuns = [];
          for (const stage of stages) {
            stage.optionalPublish = { publish, pages };
            const direct = runs(stage);
            lifecycleRuns.push(...direct);
            const queue = direct.map((run) => ({ run, trigger: stage, chain: [run.workflow] }));
            while (queue.length) {
              const { run, trigger, chain } = queue.shift();
              const workflow = load(run.workflow);
              const downstream = scenario(
                `${trigger.id}->${workflow.name}`,
                "workflow_run",
                {
                  action: "completed",
                  workflow_run: {
                    name: workflow.name,
                    conclusion: "success",
                    event: trigger.eventName,
                    head_branch:
                      trigger.event.pull_request?.head?.ref ??
                      trigger.ref.replace(/^refs\/(heads|tags)\//, ""),
                  },
                },
                trigger.ref,
              );
              downstream.optionalPublish = { publish, pages };
              const descendants = runs(downstream);
              lifecycleRuns.push(...descendants);
              for (const child of descendants) {
                if (chain.includes(child.workflow))
                  throw new Error(
                    `Cyclic workflow_run fan-out: ${[...chain, child.workflow].join(" -> ")}`,
                  );
                queue.push({ run: child, trigger: downstream, chain: [...chain, child.workflow] });
              }
            }
          }
          lifecycles.push({ diff, fork, publish, pages, runs: lifecycleRuns });
          recorded.push(...lifecycleRuns);
        }
  const maxJobs = Math.max(...recorded.map((run) => run.rows.filter((row) => row.macos).length));
  const maxRuns = Math.max(
    ...lifecycles.map(
      (lifecycle) => lifecycle.runs.filter((run) => run.rows.some((row) => row.macos)).length,
    ),
  );
  mkdirSync(join(root, ".github/.telemetry"), { recursive: true });
  writeFileSync(
    join(root, ".github/.telemetry/macos-policy.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        sourceDigest: sourceDigest(),
        events,
        scenarios: recorded,
        lifecycles,
        measurements: { jobsPerRun: maxJobs, runsPerChange: maxRuns },
      },
      null,
      2,
    ),
  );
});
test("unsupported runner expressions and reusable calls fail explicitly", () => {
  const s = scenario("unknown", "push");
  assert.throws(
    () =>
      resolveRun(
        "unknown",
        { jobs: { bad: { "runs-on": "${{ inputs.runner }}" } } },
        s,
        () => ({}),
      ),
    /Unresolved runner/,
  );
  assert.throws(
    () =>
      resolveRun(
        "unknown",
        { jobs: { bad: { uses: "other/repo/.github/workflows/x.yml@v1" } } },
        s,
        () => ({}),
      ),
    /Unresolved reusable/,
  );
});
test("real carrier command handles required work and authorized omissions", () => {
  for (const setup of ["success", "failure", "cancelled", "skipped", ""])
    for (const result of ["success", "failure", "cancelled", "skipped", ""])
      for (const required of ["true", "false", ""]) {
        const env = {
          ...process.env,
          SETUP_RESULT: setup,
          CHECK_RESULT: result,
          MACOS_REQUIRED: required,
          EVENT_NAME: "pull_request",
          OS_MATRIX: JSON.stringify(
            required === "true" ? ["ubuntu-latest", "macos-14"] : ["ubuntu-latest"],
          ),
        };
        const run = spawnSync("node", [join(root, ".github/check-results.mjs")], {
          encoding: "utf8",
          env,
        });
        assert.equal(
          run.status === 0,
          setup === "success" && result === "success" && required !== "",
          JSON.stringify(env),
        );
      }
  const run = spawnSync("node", [join(root, ".github/check-results.mjs")], {
    encoding: "utf8",
    env: {
      ...process.env,
      SETUP_RESULT: "success",
      CHECK_RESULT: "success",
      MACOS_REQUIRED: "true",
      EVENT_NAME: "pull_request",
      OS_MATRIX: '["ubuntu-latest"]',
    },
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /omission/);
});

test("budget reporter consumes recorded rows and refuses stale or missing telemetry", () => {
  const path = join(scratch, "telemetry.json");
  const recorded = readFileSync(join(root, ".github/.telemetry/macos-policy.json"), "utf8");
  const run = (file, metric) =>
    spawnSync(
      "node",
      [join(root, ".github/macos-budget.mjs"), "--metric", metric, "--telemetry", file],
      {
        encoding: "utf8",
        env: { ...process.env, ONEBUDGETSPEC_RESULT: join(scratch, "result.json") },
      },
    );
  writeFileSync(path, recorded);
  for (const metric of ["jobs-per-run", "runs-per-change"]) {
    const result = run(path, metric);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(readFileSync(join(scratch, "result.json")));
    assert.ok(Number.isFinite(report.value));
    assert.match(report.detail, /build-binary/);
  }
  const synthetic = JSON.parse(recorded);
  const row = synthetic.scenarios.flatMap((run) => run.rows).find((row) => row.macos);
  const makeRun = (name, flags) => ({
    workflow: row.workflow,
    scenario: name,
    rows: flags.map((macos) => ({ ...row, event: name, macos })),
  });
  synthetic.scenarios = [
    makeRun("three-mac-jobs", [true, false, true, true]),
    makeRun("one-mac-job", [true]),
  ];
  synthetic.lifecycles = [
    { runs: [makeRun("first", [true]), makeRun("linux", [false]), makeRun("second", [true])] },
  ];
  writeFileSync(path, JSON.stringify(synthetic));
  for (const [metric, expected] of [
    ["jobs-per-run", 3],
    ["runs-per-change", 2],
  ]) {
    const result = run(path, metric);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(join(scratch, "result.json"))).value, expected);
  }
  synthetic.scenarios[0].rows[0].macos = "false";
  writeFileSync(path, JSON.stringify(synthetic));
  assert.match(run(path, "jobs-per-run").stderr, /Malformed telemetry job row/);
  const stale = JSON.parse(recorded);
  stale.sourceDigest = "old";
  writeFileSync(path, JSON.stringify(stale));
  assert.match(run(path, "jobs-per-run").stderr, /stale telemetry/);
  rmSync(path);
  assert.notEqual(run(path, "runs-per-change").status, 0);
});

test("Linux/Windows path skips and downstream failure do not request Mac or hide prerequisites", () => {
  const bench = load(".github/workflows/bench.yml");
  const s = scenario("unaffected", "pull_request", {
    ...prEvent("version", false, true),
    action: "synchronize",
  });
  const rows = resolveRun(".github/workflows/bench.yml", bench, s, (file, id) =>
    id === "changes" ? { plugin: "false", daemon: "false", broker: "false", web: "false" } : {},
  );
  assert.deepEqual(
    rows.map((row) => row.job),
    ["changes"],
  );
  const failed = scenario("failed-publish", "workflow_run", {
    action: "completed",
    workflow_run: { name: "publish", conclusion: "failure", event: "push", head_branch: "v0.2.0" },
  });
  assert.equal(
    runs(failed)
      .flatMap((run) => run.rows)
      .some((row) => row.job === "e2e-smoke"),
    false,
  );
  for (const name of ["push", "workflow_dispatch"])
    for (const authorization of ["false", "true", ""]) {
      const diagnostic = name === "workflow_dispatch";
      const result = spawnSync("node", [join(root, ".github/check-results.mjs")], {
        encoding: "utf8",
        env: {
          ...process.env,
          SETUP_RESULT: "success",
          CHECK_RESULT: "success",
          EVENT_NAME: name,
          MACOS_REQUIRED: authorization,
          DIAGNOSTIC: String(diagnostic),
          OS_MATRIX: JSON.stringify(
            diagnostic
              ? ["ubuntu-latest", "macos-14", "windows-latest"]
              : ["ubuntu-latest", "windows-latest"],
          ),
        },
      });
      assert.equal(result.status === 0, authorization === "false");
    }
});

test("Actions status functions describe real outcome classes", () => {
  assert.equal(evaluate("failure()", {}, "failure"), true);
  assert.equal(evaluate("cancelled()", {}, "cancelled"), true);
  assert.equal(evaluate("success()", {}, "skipped"), false);
});

test("unsupported workflow trigger structures fail before routing can count zero", () => {
  const dir = mkdtempSync(join(root, ".github/.telemetry/schema-"));
  try {
    const path = join(dir, "workflow.yml");
    writeFileSync(
      path,
      "on:\n  push:\n    unknown-filter: true\njobs:\n  test:\n    runs-on: ubuntu-latest\n",
    );
    assert.throws(() => load(path.slice(root.length + 1)), /Unsupported trigger field/);
    const malformed = join(dir, "malformed.yml");
    writeFileSync(malformed, "on: push\njobs: {}\n");
    assert.throws(() => load(malformed.slice(root.length + 1)), /Unsupported workflow structure/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("production CLI rejects missing, duplicate, unknown and positional flags", () => {
  for (const [script, cases] of [
    [
      "macos-policy.mjs",
      [
        ["classify"],
        ["classify", "--event", "a", "--base", "b"],
        ["classify", "--event", "a", "--event", "b", "--base", "b", "--head", "h"],
        ["classify", "--event", "a", "--base", "b", "--head", "h", "--unknown", "x"],
      ],
    ],
    [
      "macos-budget.mjs",
      [
        ["jobs-per-run", "--telemetry", "x"],
        ["--metric", "jobs-per-run"],
        ["--metric", "jobs-per-run", "--metric", "runs-per-change", "--telemetry", "x"],
      ],
    ],
  ]) {
    for (const args of cases) {
      const result = spawnSync("node", [join(root, ".github", script), ...args], {
        encoding: "utf8",
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /option/i);
    }
  }
});

test("workspace metadata follows the git manifest instead of a fixed path list", () => {
  git("checkout", "-q", base);
  const manifest = JSON.parse(readFileSync(join(scratch, "package.json")));
  manifest.workspaces = ["apps/moved-web"];
  git("mv", "apps/web", "apps/moved-web");
  write("package.json", manifest);
  const lock = JSON.parse(readFileSync(join(scratch, "package-lock.json")));
  delete lock.packages["apps/web"];
  lock.packages["apps/moved-web"] = { name: "web", version: "0.1.0" };
  write("package-lock.json", lock);
  git("add", "package.json", "package-lock.json");
  git("commit", "-qm", "workspace declaration");
  const movedBase = git("rev-parse", "HEAD");
  lock.packages["apps/moved-web"].version = "0.2.0";
  write("package-lock.json", lock);
  git("add", "package-lock.json");
  git("commit", "-qm", "workspace metadata version");
  const movedHead = git("rev-parse", "HEAD");
  const event = prEvent("version", false, true);
  event.pull_request.base.sha = movedBase;
  event.pull_request.head.sha = movedHead;
  const path = join(scratch, "moved-event.json");
  writeFileSync(path, JSON.stringify(event));
  const result = spawnSync(
    "node",
    [
      join(root, ".github/macos-policy.mjs"),
      "classify",
      "--event",
      path,
      "--base",
      movedBase,
      "--head",
      movedHead,
    ],
    {
      cwd: scratch,
      encoding: "utf8",
      env: { ...process.env, GITHUB_EVENT_NAME: "pull_request", GITHUB_OUTPUT: "" },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).isReleaseOnly, true);
});
