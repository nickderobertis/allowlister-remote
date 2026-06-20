import assert from "node:assert/strict";
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

console.log("platform.test: ok");
