import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { requiredOptions } from "./cli-args.mjs";
import { report } from "@onebudgetspec/sdk";
import { root, sourceDigest } from "./workflow-graph.mjs";
const args = process.argv.slice(2);
const options = requiredOptions(args, ["--metric", "--telemetry"]);
const metric = options["--metric"];
if (!["jobs-per-run", "runs-per-change"].includes(metric)) throw new Error("Unknown metric");
const path = options["--telemetry"];
if (!path || path.startsWith("--")) throw new Error("Telemetry path required");
const telemetry = JSON.parse(readFileSync(resolve(root, path), "utf8"));
if (telemetry.schemaVersion !== 1 || telemetry.sourceDigest !== sourceDigest())
  throw new Error("Missing or stale telemetry: run github-workflows:test");
if (
  !Array.isArray(telemetry.scenarios) ||
  !telemetry.scenarios.length ||
  !Array.isArray(telemetry.lifecycles) ||
  !telemetry.lifecycles.length
)
  throw new Error("Missing telemetry workload");
const validateRun = (run) => {
  if (
    !run ||
    typeof run.workflow !== "string" ||
    typeof run.scenario !== "string" ||
    !Array.isArray(run.rows)
  )
    throw new Error("Malformed telemetry run");
  for (const row of run.rows)
    if (
      !row ||
      typeof row.macos !== "boolean" ||
      typeof row.workflow !== "string" ||
      typeof row.event !== "string" ||
      typeof row.job !== "string" ||
      !row.matrix ||
      typeof row.matrix !== "object"
    )
      throw new Error("Malformed telemetry job row");
};
telemetry.scenarios.forEach(validateRun);
for (const lifecycle of telemetry.lifecycles) {
  if (!lifecycle || !Array.isArray(lifecycle.runs))
    throw new Error("Malformed telemetry lifecycle");
  lifecycle.runs.forEach(validateRun);
}
const value =
  metric === "jobs-per-run"
    ? Math.max(...telemetry.scenarios.map((run) => run.rows.filter((row) => row.macos).length))
    : Math.max(
        ...telemetry.lifecycles.map(
          (lifecycle) => lifecycle.runs.filter((run) => run.rows.some((row) => row.macos)).length,
        ),
      );
const uniqueMacJobs = new Map();
for (const run of telemetry.scenarios)
  for (const row of run.rows.filter((row) => row.macos)) {
    const event = row.event.split("/").slice(0, 3).join("/");
    const reduced = { ...row, event };
    uniqueMacJobs.set(JSON.stringify([row.workflow, event, row.job, row.matrix]), reduced);
  }
const detail = JSON.stringify({
  sourceDigest: telemetry.sourceDigest,
  metric,
  macJobs: [...uniqueMacJobs.values()],
  lifecycles: telemetry.lifecycles.map((lifecycle) => {
    // llmlint: ignore[boundary_inputs_validated] Recorder-owned descriptive labels are forwarded as JSON detail; the cost computation uses validated run/job rows.
    const { diff, fork, publish, pages } = lifecycle;
    return {
      diff,
      fork,
      publish,
      pages,
      macRuns: lifecycle.runs
        .filter((run) => run.rows.some((row) => row.macos))
        .map((run) => ({
          workflow: run.workflow,
          event: run.scenario,
          jobs: run.rows.filter((row) => row.macos),
        })),
    };
  }),
});
report(value, detail);
console.log(JSON.stringify({ metric, value }));
