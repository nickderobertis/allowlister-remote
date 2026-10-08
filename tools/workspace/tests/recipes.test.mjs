// The llmlint and filtered-e2e recipes, run through the real `just` against stub
// `llmlint` / `npx` executables that record their arguments and exit with a
// chosen status: arguments arrive intact, a bad diff base is refused before
// llmlint runs, and failures propagate.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { after, describe, it } from "node:test";

const root = resolve(import.meta.dirname, "../../..");
const stubs = mkdtempSync(join(tmpdir(), "recipe-stubs-"));
after(() => rmSync(stubs, { recursive: true, force: true }));

// Each stub appends its argv (one argument per line, then a blank line) and exits
// with STUB_EXIT.
for (const tool of ["llmlint", "npx"]) {
  const path = join(stubs, tool);
  writeFileSync(
    path,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> "${stubs}/${tool}.args"\necho >> "${stubs}/${tool}.args"\nexit "\${STUB_EXIT:-0}"\n`,
  );
  chmodSync(path, 0o755);
}

const systemPath = (process.env.PATH ?? "")
  .split(delimiter)
  .filter((dir) => dir && !existsSync(join(dir, "llmlint")));

function just(args, { exit = 0, withLlmlint = true } = {}) {
  for (const tool of ["llmlint", "npx"]) rmSync(join(stubs, `${tool}.args`), { force: true });
  const dirs = withLlmlint ? [stubs, ...systemPath] : systemPath;
  const run = spawnSync("just", ["--justfile", join(root, "justfile"), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: dirs.join(delimiter), HOME: process.env.HOME, STUB_EXIT: String(exit) },
  });
  const calls = (tool) => {
    const file = join(stubs, `${tool}.args`);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n\n")
      .filter(Boolean)
      .map((call) => call.split("\n"));
  };
  return { ...run, calls };
}

describe("llmlint recipes", () => {
  it("lint-llm passes paths through unchanged, spaces included", () => {
    const run = just(["lint-llm", "a.ts", "dir with space/b.ts"]);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(run.calls("llmlint"), [["a.ts", "dir with space/b.ts"]]);
  });

  it("lint-llm-diff defaults to origin/main and forwards a base plus extra args", () => {
    assert.deepEqual(just(["lint-llm-diff"]).calls("llmlint"), [
      ["--diff", "--diff-base", "origin/main"],
    ]);
    assert.deepEqual(just(["lint-llm-diff", "HEAD~1", "--verbose"]).calls("llmlint"), [
      ["--diff", "--diff-base", "HEAD~1", "--verbose"],
    ]);
  });

  it("lint-llm-diff refuses a base that is not a plain ref, before llmlint runs", () => {
    const run = just(["lint-llm-diff", "main;touch pwned"]);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /base must be a plain git ref or SHA/);
    assert.deepEqual(run.calls("llmlint"), []);
  });

  it("lint-llm-validate forwards its options and propagates llmlint's failure", () => {
    const run = just(["lint-llm-validate", "--diff-base", "origin/main"], { exit: 3 });
    assert.notEqual(run.status, 0);
    assert.deepEqual(run.calls("llmlint"), [["validate", "--diff-base", "origin/main"]]);
  });

  it("points at setup-llmlint when llmlint is not installed", () => {
    const run = just(["lint-llm-validate"], { withLlmlint: false });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /llmlint not installed — run 'just setup-llmlint'/);
  });
});

// The stub stops at nx's command line on purpose: the real chain rebuilds the web
// bundle and three crates before Playwright starts, too slow for this unit tier.
// nx run-commands appends everything after `--` to the target's command, so the
// Playwright filters land as given — the browser e2e run itself (web-e2e) covers
// the target, and a real `just test-e2e-web <spec> --project <name>` runs only
// the named spec in the named project.
describe("test-e2e-web", () => {
  it("hands Playwright's filters to the web-e2e target and propagates its status", () => {
    const run = just(["test-e2e-web", "notifications.spec.ts", "--project", "chromium-desktop"], {
      exit: 1,
    });
    assert.notEqual(run.status, 0);
    assert.deepEqual(run.calls("npx"), [
      [
        "nx",
        "run",
        "web-e2e:test-e2e",
        "--",
        "notifications.spec.ts",
        "--project",
        "chromium-desktop",
      ],
    ]);
  });
});
