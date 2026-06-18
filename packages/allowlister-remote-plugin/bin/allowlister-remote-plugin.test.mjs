import assert from "node:assert/strict";
import { join } from "node:path";
import { nativeBinaryPath } from "./allowlister-remote-plugin.js";

assert.ok(
  nativeBinaryPath("linux", "x64").endsWith(
    join("vendor", "linux-x64", "allowlister-remote-plugin"),
  ),
);
assert.ok(
  nativeBinaryPath("win32", "x64").endsWith(
    join("vendor", "win32-x64", "allowlister-remote-plugin.exe"),
  ),
);
assert.throws(() => nativeBinaryPath("sunos", "x64"), /Unsupported platform: sunos-x64/);
