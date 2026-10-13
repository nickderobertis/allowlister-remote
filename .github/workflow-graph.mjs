// Repository-private graph proof: dynamic outputs are supplied at their real
// command boundaries. Unrecognized expressions, calls and runners are errors.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { parse } from "yaml";
import { Lexer, Parser, Evaluator, data } from "@actions/expressions";
export const root = resolve(import.meta.dirname, "..");
const parsedFiles = new Map();
export function load(path) {
  if (!parsedFiles.has(path)) {
    // llmlint: ignore[boundary_inputs_validated] Committed workflow input: GitHub validates nested Actions shapes; this reader rejects unsupported routing constructs without duplicating that schema.
    const value = parse(readFileSync(join(root, path), "utf8"));
    if (
      !value ||
      typeof value !== "object" ||
      !value.on ||
      typeof value.on !== "object" ||
      !value.jobs ||
      typeof value.jobs !== "object"
    )
      throw new Error(`Unsupported workflow structure: ${path}`);
    for (const [event, trigger] of Object.entries(value.on)) {
      if (
        ![
          "pull_request",
          "push",
          "release",
          "workflow_run",
          "repository_dispatch",
          "schedule",
          "workflow_dispatch",
          "workflow_call",
        ].includes(event)
      )
        throw new Error(`Unsupported event ${path}: ${event}`);
      if (trigger && !["workflow_dispatch", "workflow_call", "schedule"].includes(event)) {
        for (const key of Object.keys(trigger))
          if (
            ![
              "types",
              "branches",
              "tags",
              "workflows",
              "paths",
              "paths-ignore",
              "branches-ignore",
              "tags-ignore",
            ].includes(key)
          )
            throw new Error(`Unsupported trigger field ${path}: ${event}.${key}`);
      }
    }
    parsedFiles.set(path, value);
  }
  return parsedFiles.get(path);
}
const convert = (value) => {
  if (value === undefined || value === null) return new data.Null();
  if (typeof value === "string") return new data.StringData(value);
  if (typeof value === "boolean") return new data.BooleanData(value);
  if (typeof value === "number") return new data.NumberData(value);
  if (Array.isArray(value)) return new data.Array(...value.map(convert));
  return new data.Dictionary(
    ...Object.entries(value).map(([key, value]) => ({ key, value: convert(value) })),
  );
};
export function evaluate(source, context, status = "success") {
  if (typeof source !== "string") return source;
  const text = source.replace(/^\$\{\{\s*|\s*\}\}$/g, "");
  const functions = new Map(
    ["always", "success", "failure", "cancelled"].map((name) => [
      name,
      {
        name,
        minArgs: 0,
        maxArgs: 0,
        call: () =>
          new data.BooleanData(
            name === "always" ||
              (name === "success" && status === "success") ||
              (name === "failure" && status === "failure") ||
              (name === "cancelled" && status === "cancelled"),
          ),
      },
    ]),
  );
  const ast = new Parser(new Lexer(text).lex().tokens, Object.keys(context), [
    ...functions.values(),
  ]).parse();
  const value = new Evaluator(ast, convert(context), functions).evaluate();
  return JSON.parse(JSON.stringify(value, data.replacer));
}
const expression = (value, context) =>
  typeof value === "string" && value.startsWith("${{") ? evaluate(value, context) : value;
function matrixRows(matrix, context) {
  if (!matrix) return [{}];
  const resolved = typeof matrix === "string" ? expression(matrix, context) : matrix;
  let rows = [{}];
  for (const [key, values] of Object.entries(resolved)) {
    if (key === "include" || key === "exclude") continue;
    const list = expression(values, context);
    if (!Array.isArray(list)) throw new Error(`Unresolved matrix ${key}: ${JSON.stringify(list)}`);
    rows = rows.flatMap((row) => list.map((value) => ({ ...row, [key]: value })));
  }
  const keys = Object.keys(resolved).filter((key) => key !== "include" && key !== "exclude");
  if (!keys.length && resolved.include) return resolved.include;
  // GitHub applies exclusions before includes; appended include rows are never
  // original combinations eligible for later augmentation.
  // https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
  rows = rows.filter(
    (row) => !(resolved.exclude ?? []).some((exclude) =>
      Object.entries(exclude).every(([key, value]) => row[key] === value),
    ),
  );
  const additional = [];
  for (const include of resolved.include ?? []) {
    let matched = false;
    rows = rows.map((row) => {
      if (keys.every((key) => include[key] === undefined || include[key] === row[key])) {
        matched = true;
        return { ...row, ...include };
      }
      return row;
    });
    if (!matched) additional.push(include);
  }
  return [...rows, ...additional];
}
export function workflows() {
  return readdirSync(join(root, ".github/workflows"))
    .filter((file) => file.endsWith(".yml"))
    .map((file) => ({
      file: `.github/workflows/${file}`,
      workflow: load(`.github/workflows/${file}`),
    }));
}
export function triggered(workflow, scenario) {
  const trigger = workflow.on?.[scenario.eventName];
  if (trigger === undefined) return false;
  if (
    scenario.eventName === "pull_request" &&
    !trigger?.types &&
    !["opened", "synchronize", "reopened"].includes(scenario.event.action)
  )
    return false;
  if (!trigger) return true;
  if (trigger.types && !trigger.types.includes(scenario.event.action ?? "completed")) return false;
  const branch =
    scenario.eventName === "workflow_run"
      ? scenario.event.workflow_run?.head_branch
      : scenario.ref?.replace("refs/heads/", "");
  if (trigger.branches && !trigger.branches.includes(branch)) return false;
  if (
    trigger.tags &&
    !trigger.tags.some((pattern) =>
      scenario.ref?.replace("refs/tags/", "").startsWith(pattern.replace("*", "")),
    )
  )
    return false;
  if (trigger.tags && !scenario.ref?.startsWith("refs/tags/")) return false;
  if (trigger.workflows && !trigger.workflows.includes(scenario.event.workflow_run?.name))
    return false;
  if (trigger["branches-ignore"] || trigger["tags-ignore"])
    throw new Error("Unhandled workflow ref exclusion");
  if (trigger.paths || trigger["paths-ignore"]) throw new Error("Unhandled workflow path filter");
  return true;
}
export function resolveRun(
  file,
  workflow,
  scenario,
  outputFor,
  inputs = {},
  prefix = "",
  stack = [],
) {
  if (stack.includes(file)) throw new Error(`Recursive workflow call ${file}`);
  const needs = {},
    rows = [],
    visiting = new Set();
  const visit = (id) => {
    if (needs[id]) return;
    if (visiting.has(id)) throw new Error(`Dependency cycle ${file}/${id}`);
    visiting.add(id);
    const job = workflow.jobs[id];
    if (!job) throw new Error(`Missing prerequisite ${file}/${id}`);
    const dependencies = [job.needs ?? []].flat();
    for (const dependency of dependencies) visit(dependency);
    const context = {
      github: {
        event_name: scenario.eventName,
        event: scenario.event,
        repository: "nickderobertis/allowlister-remote",
        ref: scenario.ref,
        head_ref: scenario.event.pull_request?.head?.ref ?? "",
      },
      inputs,
      needs: Object.fromEntries(dependencies.map((key) => [key, needs[key]])),
    };
    const status = dependencies.every((key) => needs[key].result === "success");
    const enabled =
      (job.if === undefined
        ? status
        : Boolean(
            evaluate(
              job.if,
              context,
              status
                ? "success"
                : dependencies.some((key) => needs[key].result === "failure")
                  ? "failure"
                  : dependencies.some((key) => needs[key].result === "cancelled")
                    ? "cancelled"
                    : "skipped",
            ),
          )) &&
      (status || /always\(|failure\(|cancelled\(/.test(job.if ?? ""));
    needs[id] = {
      result: enabled ? "success" : "skipped",
      outputs: enabled ? outputFor(file, id, scenario) : {},
    };
    if (enabled && job.uses) {
      let called;
      if (job.uses.startsWith("./.github/workflows/")) called = job.uses.slice(2);
      else if (
        job.uses === "nickderobertis/screencomp/.github/workflows/visual-docs-reusable.yml@v0.4.2"
      )
        called = ".github/tests/fixtures/visual-docs-reusable.yml";
      else throw new Error(`Unresolved reusable workflow ${job.uses}`);
      const child = load(called);
      const defaults = Object.fromEntries(
        Object.entries(child.on.workflow_call.inputs ?? {}).map(([key, value]) => [
          key,
          value.default,
        ]),
      );
      const supplied = Object.fromEntries(
        Object.entries(job.with ?? {}).map(([key, value]) => [key, expression(value, context)]),
      );
      rows.push(
        ...resolveRun(
          called,
          child,
          scenario,
          outputFor,
          { ...defaults, ...scenario.optionalPublish, ...supplied },
          `${prefix}${job.name ?? id} / `,
          [...stack, file],
        ),
      );
    } else if (enabled) {
      for (const matrix of matrixRows(job.strategy?.matrix, context)) {
        const local = { ...context, matrix };
        const runner = expression(job["runs-on"], local);
        const labels = Array.isArray(runner) ? runner : [runner];
        if (
          !labels.every(
            (label) => typeof label === "string" && /^(ubuntu-|windows-|macos-)/.test(label),
          )
        )
          throw new Error(`Unresolved runner ${file}/${id}: ${JSON.stringify(runner)}`);
        const display = (job.name ?? id).replace(/\$\{\{(.*?)\}\}/g, (_, body) =>
          String(evaluate(body, local)),
        );
        rows.push({
          workflow: file,
          event: scenario.id,
          job: id,
          display: `${prefix}${display}${matrix.arch ? ` (${matrix.arch})` : ""}`,
          runner,
          matrix,
          macos: labels.some((label) => label.startsWith("macos-")),
        });
      }
    }
    visiting.delete(id);
  };
  for (const id of Object.keys(workflow.jobs)) visit(id);
  return rows;
}
export function sourceDigest() {
  const paths = [];
  const walk = (path) => {
    for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
      if (["node_modules", ".telemetry"].includes(entry.name)) continue;
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else paths.push(child);
    }
  };
  walk(".github");
  paths.push(
    "package.json",
    "package-lock.json",
    "screencomp.toml",
    "rust-toolchain.toml",
    "packages/allowlister-remote-plugin/scripts/build-release-binaries.sh",
    "packages/allowlister-remote-plugin/scripts/smoke-native-release.sh",
    "scripts/smoke-npm-package.sh",
    "scripts/stage-npm-package.mjs",
  );
  for (const platform of load(".github/workflows/publish.yml").jobs["build-binary"].strategy.matrix
    .include)
    paths.push(`packages/allowlister-remote-plugin-${platform.platform}/package.json`);
  const hash = createHash("sha256");
  for (const path of paths.sort()) hash.update(path).update(readFileSync(join(root, path)));
  return hash.digest("hex");
}
