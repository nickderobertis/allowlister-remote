import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { binarySpecifier, daemonSpecifier, platformPackage } from "../lib/platform.mjs";

assert.deepEqual(platformPackage("linux", "x64"), {
  name: "@nickderobertis/allowlister-remote-plugin-linux-x64",
  file: "allowlister-remote-plugin",
  daemonFile: "allowlister-remote-daemon",
});
assert.deepEqual(platformPackage("darwin", "arm64"), {
  name: "@nickderobertis/allowlister-remote-plugin-darwin-arm64",
  file: "allowlister-remote-plugin",
  daemonFile: "allowlister-remote-daemon",
});
assert.deepEqual(platformPackage("win32", "x64"), {
  name: "@nickderobertis/allowlister-remote-plugin-win32-x64",
  file: "allowlister-remote-plugin.exe",
  daemonFile: "allowlister-remote-daemon.exe",
});

assert.equal(
  binarySpecifier("linux", "x64"),
  "@nickderobertis/allowlister-remote-plugin-linux-x64/bin/allowlister-remote-plugin",
);
assert.equal(
  binarySpecifier("win32", "x64"),
  "@nickderobertis/allowlister-remote-plugin-win32-x64/bin/allowlister-remote-plugin.exe",
);

assert.equal(
  daemonSpecifier("linux", "x64"),
  "@nickderobertis/allowlister-remote-plugin-linux-x64/bin/allowlister-remote-daemon",
);
assert.equal(
  daemonSpecifier("win32", "x64"),
  "@nickderobertis/allowlister-remote-plugin-win32-x64/bin/allowlister-remote-daemon.exe",
);

assert.throws(() => platformPackage("sunos", "x64"), /Unsupported platform: sunos-x64/);
assert.throws(() => binarySpecifier("linux", "arm"), /Unsupported platform: linux-arm/);
assert.throws(() => daemonSpecifier("linux", "arm"), /Unsupported platform: linux-arm/);
assert.throws(() => platformPackage("darwin", "x64"), /Intel macOS \(darwin-x64\) is no longer supported/);
assert.throws(() => daemonSpecifier("darwin", "x64"), /Intel macOS \(darwin-x64\) is no longer supported/);

// Run the real JS launcher as an Intel Mac would, doubling only the host's
// reported platform/arch: it refuses with the Intel message rather than going
// looking for a darwin-x64 package that is never published.
const launcher = fileURLToPath(new URL("../bin/allowlister-remote-plugin", import.meta.url));
function runLauncherAs(platform, arch) {
  const preload = `data:text/javascript,Object.defineProperty(process,"platform",{value:${JSON.stringify(platform)}});Object.defineProperty(process,"arch",{value:${JSON.stringify(arch)}});`;
  return spawnSync(process.execPath, ["--import", preload, launcher, "--version"], {
    encoding: "utf8",
  });
}

const intel = runLauncherAs("darwin", "x64");
assert.equal(intel.status, 1, intel.stderr);
assert.match(intel.stderr, /Intel macOS \(darwin-x64\) is no longer supported/);
assert.doesNotMatch(intel.stderr, /Missing native/);

// Apple Silicon stays supported: without its platform package installed the
// launcher reports the missing arm64 binary, not the Intel refusal.
const appleSilicon = runLauncherAs("darwin", "arm64");
assert.equal(appleSilicon.status, 1, appleSilicon.stderr);
assert.match(appleSilicon.stderr, /Missing native allowlister-remote-plugin binary for darwin-arm64/);
assert.doesNotMatch(appleSilicon.stderr, /Intel macOS/);

console.log("platform.test: ok");
