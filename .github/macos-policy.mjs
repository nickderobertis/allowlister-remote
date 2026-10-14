import { execFileSync } from "node:child_process";
import { readFileSync, appendFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { requiredOptions } from "./cli-args.mjs";
const version = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;
/** @param {...string} args */
const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
/** @param {string} ref */
const commit = (ref) => git("rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`).trim();
/** @param {string} path @param {string} before @param {string} after @param {string[]} workspaces */
function jsonVersionsOnly(path, before, after, workspaces) {
  /** @param {unknown} value @returns {value is Record<string, unknown>} */
  function isRecord(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }
  /** @param {Record<string, unknown>} value */
  const strip = (value) => {
    const copy = structuredClone(value);
    /** @param {unknown} value */
    const removeVersion = (value) => {
      if (!isRecord(value)) throw new Error("invalid version object");
      const obj = value;
      if (typeof obj.version !== "string" || !version.test(obj.version))
        throw new Error("invalid version");
      delete obj.version;
    };
    if (path === ".release-please-manifest.json") {
      if (
        Object.keys(copy).some((key) => key !== ".") ||
        typeof copy["."] !== "string" ||
        !version.test(copy["."])
      )
        return null;
      delete copy["."];
    } else if (path.endsWith("package-lock.json")) {
      removeVersion(copy);
      if (!copy.packages || typeof copy.packages !== "object" || Array.isArray(copy.packages))
        throw new Error("invalid lock packages");
      for (const [key, entry] of Object.entries(copy.packages)) {
        // Dependency versions are content, only workspace versions are metadata.
        if (key === "" || workspaces.includes(key)) removeVersion(entry);
      }
    } else removeVersion(copy);
    return copy;
  };
  const left = strip(JSON.parse(before)),
    right = strip(JSON.parse(after));
  return left !== null && right !== null && isDeepStrictEqual(left, right);
}
/** @param {string} base @param {string} head */
function versionDiffOnly(base, head) {
  const files = git("diff", "--name-status", "--no-renames", base, head).trim().split("\n");
  if (!files[0]) return false;
  /** @param {string} ref @returns {string[]} */
  const workspacePaths = (ref) => {
    const paths = JSON.parse(git("show", `${ref}:package.json`)).workspaces ?? [];
    if (
      !Array.isArray(paths) ||
      !paths.every(
        (path) =>
          typeof path === "string" &&
          /^[\w.-]+(?:\/[\w.-]+)*$/.test(path) &&
          !path.split("/").includes(".."),
      )
    )
      throw new Error("Unsupported workspace declaration");
    return paths;
  };
  const workspaces = workspacePaths(base);
  if (!isDeepStrictEqual(workspaces, workspacePaths(head))) return false;

  return files.every((line) => {
    const [status, path] = line.split("\t");
    if (status !== "M") return false;
    const before = git("show", `${base}:${path}`),
      after = git("show", `${head}:${path}`);
    if (path === "CHANGELOG.md")
      return /^# Changelog\s/m.test(after) && /^## \[?\d+\.\d+\.\d+/m.test(after);
    if (
      path === ".release-please-manifest.json" ||
      path === "package.json" ||
      path === "package-lock.json" ||
      workspaces.some((workspace) => path === `${workspace}/package.json`) ||
      /^packages\/allowlister-remote-[\w-]+\/package.json$/.test(path)
    )
      return jsonVersionsOnly(path, before, after, workspaces);
    return false;
  });
}
/**
 * @param {string} eventPath
 * @param {string} base
 * @param {string} head
 * @param {string | undefined} [eventName]
 * @returns {{isReleaseOnly:boolean, macosRequired:boolean, reason:string}}
 */
export function classify(eventPath, base, head, eventName = process.env.GITHUB_EVENT_NAME) {
  const nonPrEvents = new Set([
    "push",
    "release",
    "workflow_run",
    "repository_dispatch",
    "schedule",
    "workflow_dispatch",
    "workflow_call",
  ]);
  if (eventName && nonPrEvents.has(eventName))
    return { isReleaseOnly: false, macosRequired: false, reason: "non-PR event" };
  if (eventName && eventName !== "pull_request")
    return {
      isReleaseOnly: false,
      macosRequired: true,
      reason: `unrecognised event ${JSON.stringify(eventName)}: failing closed to macOS`,
    };
  try {
    // llmlint: ignore[boundary_inputs_validated] The internal CLI intentionally accepts an event fixture path; GitHub supplies GITHUB_EVENT_PATH in production, and unreadable/malformed content requires Mac coverage.
    const event = JSON.parse(readFileSync(eventPath, "utf8"));
    if (!event.pull_request) throw new Error("missing PR");
    const pr = event.pull_request;
    const repo = event.repository?.full_name;
    const authorized =
      typeof repo === "string" &&
      /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repo) &&
      pr.head?.repo?.full_name === repo &&
      pr.base?.repo?.full_name === repo &&
      typeof pr.head?.ref === "string" &&
      /^release-please--branches--main(?:--|$)/.test(pr.head?.ref ?? "");
    // A literal-true draft defers its Mac lane to ready_for_review, which
    // re-runs every required context; any other draft value fails closed.
    const draft = pr.draft === true;
    let release;
    try {
      release = authorized && versionDiffOnly(commit(base), commit(head));
    } catch (error) {
      if (!draft) throw error;
      release = false;
    }
    if (!release && draft)
      return {
        isReleaseOnly: false,
        macosRequired: false,
        reason: "draft pull request: Mac lane deferred to ready_for_review",
      };
    return {
      isReleaseOnly: release,
      macosRequired: !release,
      reason: release
        ? "same-repository release-please version/changelog-only diff"
        : "ordinary or unverified PR",
    };
  } catch {
    return {
      isReleaseOnly: false,
      macosRequired: true,
      reason: "unknown or unreadable PR classification",
    };
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args[0] !== "classify")
    throw new Error("expected classify --event PATH --base REF --head REF");
  const options = requiredOptions(args.slice(1), ["--event", "--base", "--head"]);
  const result = classify(options["--event"], options["--base"], options["--head"]);
  console.log(JSON.stringify(result));
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `macosRequired=${result.macosRequired}\nisReleaseOnly=${result.isReleaseOnly}\nreason=${result.reason}\n`,
    );
}
