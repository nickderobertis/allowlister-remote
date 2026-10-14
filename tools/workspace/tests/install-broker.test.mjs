// scripts/install-broker.sh, run through real bash with only the host's `uname`
// and the GitHub download transport (`curl`) doubled: Intel macOS is refused
// before anything is fetched, while Apple Silicon still resolves its arm64 asset.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { after, describe, it } from "node:test";

const root = resolve(import.meta.dirname, "../../..");
const stubs = mkdtempSync(join(tmpdir(), "install-broker-stubs-"));
after(() => rmSync(stubs, { recursive: true, force: true }));

writeFileSync(
  join(stubs, "uname"),
  '#!/usr/bin/env bash\ncase "$1" in -s) echo "$STUB_OS" ;; -m) echo "$STUB_ARCH" ;; *) exit 2 ;; esac\n',
);
writeFileSync(
  join(stubs, "curl"),
  `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> "${stubs}/curl.args"\nexit 22\n`,
);
for (const tool of ["uname", "curl"]) chmodSync(join(stubs, tool), 0o755);

function install(os, arch) {
  rmSync(join(stubs, "curl.args"), { force: true });
  const binDir = join(stubs, "bin");
  const run = spawnSync(
    "bash",
    [join(root, "scripts/install-broker.sh"), "--version", "v9.9.9", "--bin-dir", binDir],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: [stubs, process.env.PATH ?? ""].join(delimiter),
        STUB_OS: os,
        STUB_ARCH: arch,
      },
    },
  );
  const curlArgs = existsSync(join(stubs, "curl.args"))
    ? readFileSync(join(stubs, "curl.args"), "utf8")
    : "";
  return { ...run, curlArgs, installed: existsSync(join(binDir, "allowlister-remote-broker")) };
}

describe("install-broker.sh macOS architectures", () => {
  it("refuses Intel macOS as no longer supported without downloading", () => {
    const run = install("Darwin", "x86_64");
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /Intel macOS \(x86_64\) is no longer supported/);
    assert.equal(run.curlArgs, "", "no release asset may be fetched for Intel macOS");
    assert.equal(run.installed, false);
  });

  it("still resolves the Apple Silicon asset", () => {
    const run = install("Darwin", "arm64");
    assert.doesNotMatch(run.stderr, /Intel macOS/);
    assert.match(
      run.curlArgs,
      /releases\/download\/v9\.9\.9\/allowlister-remote-broker-darwin-arm64$/m,
    );
    // Stopping at the doubled download keeps this test offline; reaching it is the proof.
    assert.equal(run.status, 1);
    assert.match(run.stderr, /failed to download allowlister-remote-broker-darwin-arm64/);
    assert.equal(run.installed, false);
  });
});
