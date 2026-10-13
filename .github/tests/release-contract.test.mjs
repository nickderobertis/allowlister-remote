import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, rmSync, mkdtempSync, cpSync, mkdirSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { parse, stringify } from "yaml";
import { load, root, evaluate } from "../workflow-graph.mjs";
const publish = load(".github/workflows/publish.yml");
test("all release platforms retain three binaries, npm carriers, checksums and native Mac smoke before Linux publication", () => {
  const build = publish.jobs["build-binary"];
  const golden = JSON.parse(
    readFileSync(join(root, ".github/tests/fixtures/release-platforms.json")),
  );
  assert.deepEqual(
    build.strategy.matrix.include.map(({ platform, target, exe }) => ({ platform, target, exe })),
    golden.platforms.map(({ platform, target, exe }) => ({ platform, target, exe })),
  );

  const toolchain = readFileSync(join(root, "rust-toolchain.toml"), "utf8");
  const targets = [...toolchain.match(/^targets.*$/m)[0].matchAll(/"([^"]+)"/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(build.strategy.matrix.include.map((row) => row.target).sort(), targets.sort());
  // Darwin/Windows execution belongs to their native release runners. The
  // carrier journey below exercises real staging/packing with inert foreign
  // payloads; the separate Linux builder journey runs genuine native binaries.
  const builder = readFileSync(
    join(root, "packages/allowlister-remote-plugin/scripts/build-release-binaries.sh"),
    "utf8",
  );
  for (const binary of ["plugin", "daemon", "broker"])
    assert.ok(builder.includes(`allowlister-remote-${binary}`));
  assert.match(
    builder,
    /cp "target\/\$target\/release\/\$binary\$exe" "dist\/artifacts\/\$binary-\$platform\$exe"/,
  );
  const stage = readFileSync(join(root, "scripts/stage-npm-package.mjs"), "utf8");
  for (const row of build.strategy.matrix.include) {
    const manifest = JSON.parse(
      readFileSync(join(root, `packages/allowlister-remote-plugin-${row.platform}/package.json`)),
    );
    const [os, cpu] = row.platform.split("-");
    assert.deepEqual(manifest.os, [os]);
    assert.deepEqual(manifest.cpu, [cpu]);
    assert.ok(stage.includes(`target: "${row.platform}"`));
    assert.ok(
      row.target.includes(
        os === "darwin" ? "apple-darwin" : os === "win32" ? "windows-msvc" : "linux-musl",
      ),
    );
  }
  const buildStep = build.steps.find((step) => step.run?.includes("build-release-binaries.sh"));
  const nativeSmoke = build.steps.find((step) => step.run?.includes("smoke-native-release.sh"));
  assert.ok(build.steps.indexOf(nativeSmoke) > build.steps.indexOf(buildStep));
  assert.ok(
    build.steps.indexOf(nativeSmoke) <
      build.steps.findIndex((step) => step.uses?.startsWith("actions/upload-artifact")),
  );
  assert.equal(evaluate(nativeSmoke.if, { runner: { os: "macOS" } }), true);
  assert.equal(evaluate(nativeSmoke.if, { runner: { os: "Linux" } }), false);
  for (const id of ["github-release", "npm-publish", "web-publish"])
    assert.equal(publish.jobs[id]["runs-on"], "ubuntu-latest");
  assert.equal(publish.jobs["github-release"].needs, "build-binary");
  assert.deepEqual(publish.jobs["npm-publish"].needs, ["build-binary", "github-release"]);
  assert.ok(
    build.steps.some((step) =>
      step.run?.includes("ALLOWLISTER_REMOTE_PLUGIN_VERSION=${GITHUB_REF_NAME#v}"),
    ),
  );
  for (const binary of ["plugin", "daemon", "broker"])
    assert.ok(
      publish.jobs["github-release"].steps.some((step) =>
        step.with?.files?.includes(`allowlister-remote-${binary}-*`),
      ),
    );
  assert.ok(publish.jobs["github-release"].steps.some((step) => step.run?.includes("SHA256SUMS")));
  const smoke = load(".github/workflows/e2e-smoke.yml");
  assert.deepEqual(smoke.on.workflow_run.workflows, ["publish"]);
  assert.equal(smoke.jobs["e2e-smoke"]["runs-on"], "ubuntu-latest");
  assert.ok(
    smoke.jobs["e2e-smoke"].steps.some((step) =>
      step.run?.includes("scripts/install-broker.sh --version"),
    ),
  );
  assert.ok(smoke.jobs["e2e-smoke"].steps.some((step) => step.run?.includes("release:smoke-e2e")));
});
test("pinned reusable workflow fixture has exact source provenance", () => {
  const fixture = JSON.parse(readFileSync(join(root, ".github/tests/fixtures/provenance.json")));
  assert.equal(load(".github/workflows/visual-docs.yml").jobs["visual-docs"].uses, fixture.call);
  assert.equal(fixture.schemaVersion, 1);
  const raw = JSON.parse(readFileSync(join(root, fixture.sourcePath))).source;
  assert.equal(createHash("sha256").update(raw).digest("hex"), fixture.sourceSha256);
  assert.equal(stringify(parse(raw)), readFileSync(join(root, fixture.path), "utf8"));

  assert.equal(
    createHash("sha256")
      .update(readFileSync(join(root, fixture.path)))
      .digest("hex"),
    fixture.sha256,
  );
});

test("downstream smoke follows the exact release tag and refuses failed publication", () => {
  const smoke = load(".github/workflows/e2e-smoke.yml");
  const job = smoke.jobs["e2e-smoke"];
  assert.equal(
    evaluate(job.if, {
      github: { event_name: "workflow_run", event: { workflow_run: { conclusion: "failure" } } },
    }),
    false,
  );
  assert.equal(
    evaluate(job.if, {
      github: { event_name: "workflow_run", event: { workflow_run: { conclusion: "success" } } },
    }),
    true,
  );
  const resolve = job.steps.find((step) => step.id === "version");
  const output = join(
    mkdtempSync(
      join(
        process.env.ONEPIPELINE_NODE_SCRATCH_DIR ?? join(root, ".github/.telemetry"),
        "smoke-tag-",
      ),
    ),
    "output",
  );
  writeFileSync(output, "");
  try {
    const run = spawnSync("bash", ["-e", "-c", resolve.run], {
      encoding: "utf8",
      env: { ...process.env, INPUT_VERSION: "", TRIGGER_REF: "v0.2.0", GITHUB_OUTPUT: output },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(readFileSync(output, "utf8"), "version=0.2.0\n");
  } finally {
    rmSync(output, { force: true });
  }
});

test("production staging and npm packing preserve every platform payload and version without executing foreign binaries", () => {
  // A Linux dispatch cannot execute Darwin/Windows binaries. The production
  // native build/install journey covers real execution; this boundary proves
  // staging and carrier compatibility using distinguishable inert payloads.
  const scratch = mkdtempSync(
    join(
      process.env.ONEPIPELINE_NODE_SCRATCH_DIR ?? join(root, ".github/.telemetry"),
      "carrier-contract-",
    ),
  );
  try {
    cpSync(join(root, "packages"), join(scratch, "packages"), { recursive: true });
    const artifacts = join(scratch, "artifacts");
    mkdirSync(artifacts);
    const golden = JSON.parse(
      readFileSync(join(root, ".github/tests/fixtures/release-platforms.json")),
    );
    for (const row of golden.platforms)
      for (const name of row.artifacts)
        writeFileSync(join(artifacts, name), `Inert contract payload: ${row.target} / ${name}\n`);
    execFileSync("node", [join(root, "scripts/set-npm-package-version.mjs"), "0.2.0"], {
      cwd: scratch,
    });
    execFileSync("node", [join(root, "scripts/stage-npm-package.mjs"), artifacts], {
      cwd: scratch,
    });
    for (const row of golden.platforms) {
      const validate = spawnSync(
        "bash",
        [
          join(root, "packages/allowlister-remote-plugin/scripts/build-release-binaries.sh"),
          row.target,
          row.platform,
          row.exe,
          "--validate",
        ],
        { encoding: "utf8" },
      );
      assert.equal(validate.status, 0, validate.stderr);
      const carrier = join(scratch, `packages/allowlister-remote-plugin-${row.platform}`);
      const packed = JSON.parse(
        execFileSync("npm", ["pack", carrier, "--json", "--pack-destination", scratch], {
          encoding: "utf8",
        }),
      )[0];
      const unpacked = join(scratch, row.platform);
      mkdirSync(unpacked);
      execFileSync("tar", ["xf", join(scratch, packed.filename), "-C", unpacked]);
      const manifest = JSON.parse(readFileSync(join(unpacked, "package/package.json")));
      assert.equal(manifest.version, "0.2.0");
      assert.equal(manifest.name, `@nickderobertis/allowlister-remote-plugin-${row.platform}`);
      const expected = Object.fromEntries(
        row.npmPayloads.map((payload, index) => [payload, row.artifacts[index]]),
      );
      const payloads = packed.files
        .filter((file) => file.path.startsWith("bin/"))
        .map((file) => file.path)
        .sort();
      assert.deepEqual(payloads, Object.keys(expected).sort());
      for (const [payload, artifact] of Object.entries(expected))
        assert.deepEqual(
          readFileSync(join(unpacked, "package", payload)),
          readFileSync(join(artifacts, artifact)),
        );
    }
    const web = JSON.parse(
      readFileSync(join(root, "packages/allowlister-remote-web/package.json")),
    );
    assert.equal(web.name, golden.webPackage);
    const invalid = spawnSync(
      "bash",
      [
        join(root, "packages/allowlister-remote-plugin/scripts/build-release-binaries.sh"),
        "../bad",
        "linux-x64",
        "",
        "--validate",
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /Invalid release target/);
    rmSync(join(artifacts, golden.platforms[0].artifacts[0]));
    const missing = spawnSync("node", [join(root, "scripts/stage-npm-package.mjs"), artifacts], {
      cwd: scratch,
      encoding: "utf8",
    });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /Missing release artifact/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
