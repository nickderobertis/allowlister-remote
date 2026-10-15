// result.mjs, run as measure.sh runs it: well-formed input passes through, and
// every malformed input is refused with exit 2 and a message naming what is wrong.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";

const script = resolve(import.meta.dirname, "../result.mjs");
const scratch = mkdtempSync(join(tmpdir(), "pool-maintenance-result-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const result = (args, input = "") =>
  spawnSync(process.execPath, [script, ...args], { input, encoding: "utf8" });

function refused(run, message) {
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, message);
}

describe("crates", () => {
  it("prints each package name from cargo metadata", () => {
    const run = result(
      ["crates"],
      JSON.stringify({ packages: [{ name: "a-b" }, { name: "c_d" }] }),
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, "a-b\nc_d\n");
  });

  it("refuses output that is not JSON", () => {
    refused(result(["crates"], "error: no manifest"), /cargo metadata did not print JSON/);
  });

  it("refuses metadata listing no packages", () => {
    refused(result(["crates"], "{}"), /listed no `packages`/);
    refused(result(["crates"], '{"packages":[]}'), /listed no `packages`/);
  });

  it("refuses a package name that is not plain", () => {
    refused(
      result(["crates"], JSON.stringify({ packages: [{ name: "a; rm -rf /" }] })),
      /package without a plain name/,
    );
  });
});

describe("merge", () => {
  const write = (name, body) => {
    const path = join(scratch, name);
    writeFileSync(path, body);
    return path;
  };
  const timed = write("timed.json", JSON.stringify({ value: 1.5, detail: "builds removed: 3" }));
  const backlog = write("backlog.json", JSON.stringify({ value: 0.25, detail: "x" }));
  const out = join(scratch, "out.json");

  it("keeps the timed value and appends the counts and backlog seconds to its detail", () => {
    const run = result(["merge", timed, backlog, out, "  12", "12"]);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), {
      value: 1.5,
      detail:
        "builds removed: 3; alternative entries created: 12; entries removed: 12; " +
        "untimed backlog pass (not in the figure): 0.25 seconds",
    });
  });

  it("refuses a report that is not JSON", () => {
    refused(
      result(["merge", write("bad.json", "nope"), backlog, out, "1", "1"]),
      /is not the pruner's onebudgetspec report/,
    );
  });

  it("refuses a report without a numeric value and string detail", () => {
    for (const body of [{ detail: "x" }, { value: -1, detail: "x" }, { value: 1 }]) {
      refused(
        result(["merge", timed, write("shape.json", JSON.stringify(body)), out, "1", "1"]),
        /lacks a non-negative numeric `value` and a string `detail`/,
      );
    }
  });

  it("refuses an entry count that is not an integer", () => {
    refused(result(["merge", timed, backlog, out, "many", "1"]), /created entry count/);
  });
});

it("refuses an unknown command or argument count with its usage", () => {
  for (const args of [[], ["crates", "extra"], ["merge", "one"], ["bogus"]]) {
    refused(result(args), /usage: result\.mjs crates \| merge/);
  }
});
