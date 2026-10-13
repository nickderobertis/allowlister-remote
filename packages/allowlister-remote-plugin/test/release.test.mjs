// Slow packaging edge: real Rust build, npm pack/install, launcher and native
// commands. The host target is explicit; non-native targets are contract proof.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "../../..");
// llmlint: ignore[boundary_inputs_validated] Installed pinned rustc supplies its documented host field; this test has no external tool-output fixture and the production builder validates the target/platform pair.
const host = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (.*)$/m)[1];
const platform = `${process.platform}-${process.arch}`;
const version = "0.0.0-local-proof";
// llmlint: ignore-block[boundary_inputs_validated] Dispatch-owned writable scratch directory is supplied by the harness contract; the fallback is repository-local and no public path input is accepted.
const scratchRoot = process.env.ONEPIPELINE_NODE_SCRATCH_DIR ?? `${root}/.local/`;
mkdirSync(scratchRoot, { recursive: true });
// llmlint: ignore-end[boundary_inputs_validated]
const env = { ...process.env, TMPDIR: scratchRoot, ALLOWLISTER_REMOTE_PLUGIN_VERSION: version };
const run = (script, args = [], cwd = root) =>
  spawnSync("npm", ["run", script, "--", ...args], { cwd, env, encoding: "utf8", timeout: 600000 });
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
test("production builder -> identical artifact/carrier bytes -> real native install and launcher; missing broker fails", {
  skip:
    process.platform !== "linux"
      ? "Linux-only local native journey: Darwin smoke runs on the real Mac release builder before publication; Windows is covered by real staging/packing. No pre-existing assertion is skipped."
      : false,
}, () => {
  const build = run("release:build-binaries", [host, platform, ""]);
  assert.equal(build.status, 0, build.stderr);
  const scratch = mkdtempSync(join(scratchRoot, "release-"));
  try {
    mkdirSync(join(scratch, "scripts"));
    cpSync(join(root, "packages"), join(scratch, "packages"), { recursive: true });
    const artifacts = join(root, "dist/artifacts");
    for (const binary of ["plugin", "daemon", "broker"]) {
      const name = `allowlister-remote-${binary}`;
      assert.equal(
        hash(join(root, `target/${host}/release/${name}`)),
        hash(join(artifacts, `${name}-${platform}`)),
      );
    }
    const smokeArgs = ["run", "release:smoke-native", "--", artifacts];
    const invalidVersion = spawnSync("npm", smokeArgs, {
      cwd: root,
      encoding: "utf8",
      env: { ...env, ALLOWLISTER_REMOTE_PLUGIN_VERSION: "invalid" },
    });
    assert.notEqual(invalidVersion.status, 0);
    assert.match(invalidVersion.stderr, /Invalid release version/);
    const wrongVersion = spawnSync("npm", smokeArgs, {
      cwd: root,
      encoding: "utf8",
      env: { ...env, ALLOWLISTER_REMOTE_PLUGIN_VERSION: "9.9.9" },
    });
    assert.notEqual(wrongVersion.status, 0);
    assert.match(wrongVersion.stderr, /differs.*Rebuild/);
    const smoke = run("release:smoke-native", [artifacts]);
    assert.equal(smoke.status, 0, smoke.stderr);
    const partial = join(scratch, "partial");
    mkdirSync(partial);
    for (const name of ["plugin", "daemon"])
      cpSync(
        join(artifacts, `allowlister-remote-${name}-${platform}`),
        join(partial, `allowlister-remote-${name}-${platform}`),
      );
    const missing = run("release:smoke-native", [partial]);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /broker/);
    // llmlint: ignore[boundary_inputs_validated] Trusted repository fixture manifest; npm pack validates the copied package, and no external manifest input is accepted by this test.
    const manifest = JSON.parse(
      readFileSync(join(root, `packages/allowlister-remote-plugin-${platform}/package.json`)),
    );
    manifest.version = version;
    const carrier = join(scratch, `packages/allowlister-remote-plugin-${platform}`);
    mkdirSync(join(carrier, "bin"), { recursive: true });
    writeFileSync(join(carrier, "package.json"), JSON.stringify(manifest));
    for (const name of ["plugin", "daemon"])
      cpSync(
        join(artifacts, `allowlister-remote-${name}-${platform}`),
        join(carrier, `bin/allowlister-remote-${name}`),
      );
    // llmlint: ignore[boundary_inputs_validated] Real npm pack runs against the test-owned carrier and destination; its installed tool result is consumed locally without accepting an external archive path.
    const packed = JSON.parse(
      execFileSync("npm", ["pack", carrier, "--json", "--pack-destination", scratch], {
        encoding: "utf8",
      }),
    )[0];
    const unpacked = join(scratch, "unpacked");
    mkdirSync(unpacked);
    execFileSync("tar", ["xf", join(scratch, packed.filename), "-C", unpacked]);
    for (const name of ["plugin", "daemon"])
      assert.equal(
        hash(join(artifacts, `allowlister-remote-${name}-${platform}`)),
        hash(join(unpacked, `package/bin/allowlister-remote-${name}`)),
      );
    const npmSmoke = (expectedVersion) =>
      spawnSync("npm", ["run", "release:smoke-npm", "--", join(scratch, "packages")], {
        cwd: root,
        encoding: "utf8",
        env: { ...env, ALLOWLISTER_REMOTE_PLUGIN_VERSION: expectedVersion },
      });
    rmSync(join(carrier, "bin/allowlister-remote-plugin"));
    const missingInstalledPlugin = npmSmoke(version);
    assert.notEqual(missingInstalledPlugin.status, 0);
    assert.match(missingInstalledPlugin.stderr, /Fallback plugin cannot execute.*Restage/);
    cpSync(
      join(artifacts, `allowlister-remote-plugin-${platform}`),
      join(carrier, "bin/allowlister-remote-plugin"),
    );
    const wrongInstalledVersion = npmSmoke("9.9.9");
    assert.notEqual(wrongInstalledVersion.status, 0);
    assert.match(wrongInstalledVersion.stderr, /Installed plugin version.*9\.9\.9/);
    // This is another genuine daemon build, not a fake subprocess: a stale
    // release component must be rejected by the real npm install smoke.
    execFileSync(
      "cargo",
      ["build", "--locked", "--release", "--target", host, "-p", "allowlister-remote-daemon"],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...env, ALLOWLISTER_REMOTE_PLUGIN_VERSION: "0.0.0-daemon-mismatch" },
      },
    );
    cpSync(
      join(root, `target/${host}/release/allowlister-remote-daemon`),
      join(carrier, "bin/allowlister-remote-daemon"),
    );
    const wrongDaemonVersion = npmSmoke(version);
    assert.notEqual(wrongDaemonVersion.status, 0);
    assert.match(wrongDaemonVersion.stderr, /Daemon version.*daemon-mismatch.*plugin/);
    cpSync(
      join(artifacts, `allowlister-remote-daemon-${platform}`),
      join(carrier, "bin/allowlister-remote-daemon"),
    );
    const recovered = npmSmoke(version);
    assert.equal(recovered.status, 0, recovered.stderr);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("native smoke refuses an empty release version before using artifacts", () => {
  const result = spawnSync("npm", ["run", "release:smoke-native", "--", "missing-artifacts"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ALLOWLISTER_REMOTE_PLUGIN_VERSION: "" },
  });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /ALLOWLISTER_REMOTE_PLUGIN_VERSION: Set ALLOWLISTER_REMOTE_PLUGIN_VERSION/,
  );
});
