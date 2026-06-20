// Integration test for the post-install step (`install.mjs`).
//
// Recreates the layout npm produces for a real install — the parent package
// under `node_modules/@nickderobertis/allowlister-remote-plugin` with the
// matching per-platform package (carrying stub plugin and daemon binaries)
// alongside it — then runs `install.mjs` and asserts BOTH the plugin and the
// daemon land in `bin/` as siblings. The daemon must be a sibling of the plugin
// so the plugin's `resolve_daemon_bin` lookup finds the daemon it auto-starts.
//
// Windows keeps the JS launcher (npm shims invoke it through Node), so the
// in-place native swap — and this sibling assertion — only applies off Windows.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { platformPackage } from "../lib/platform.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(here);

if (process.platform === "win32") {
  console.log("install.test: skipped on win32 (JS launcher kept by design)");
  process.exit(0);
}

const { name: platformPkgName, file, daemonFile } = platformPackage();

const work = mkdtempSync(join(tmpdir(), "allowlister-install-test-"));
try {
  // node_modules/@nickderobertis/allowlister-remote-plugin (the parent)
  const scopeDir = join(work, "node_modules", "@nickderobertis");
  const parentDir = join(scopeDir, "allowlister-remote-plugin");
  mkdirSync(parentDir, { recursive: true });
  // Copy the parent's shippable files into the installed location.
  for (const entry of ["install.mjs", "lib", "bin", "package.json"]) {
    cpSync(join(packageRoot, entry), join(parentDir, entry), { recursive: true });
  }

  // The matching per-platform package, carrying stub plugin + daemon binaries.
  const platDir = join(scopeDir, platformPkgName.replace("@nickderobertis/", ""));
  const platBin = join(platDir, "bin");
  mkdirSync(platBin, { recursive: true });
  writeFileSync(join(platBin, file), "#native-plugin\n");
  chmodSync(join(platBin, file), 0o755);
  writeFileSync(join(platBin, daemonFile), "#native-daemon\n");
  chmodSync(join(platBin, daemonFile), 0o755);
  writeFileSync(
    join(platDir, "package.json"),
    `${JSON.stringify({ name: platformPkgName, version: "0.0.0-test" }, null, 2)}\n`,
  );

  // Run the post-install step exactly as npm would, from the installed location.
  execFileSync(process.execPath, [join(parentDir, "install.mjs")], { stdio: "pipe" });

  const pluginOnPath = join(parentDir, "bin", "allowlister-remote-plugin");
  const daemonOnPath = join(parentDir, "bin", "allowlister-remote-daemon");

  // Both native binaries must now sit side by side in the parent's bin/.
  assert.equal(
    readFileSync(pluginOnPath, "utf8"),
    "#native-plugin\n",
    "plugin binary should be linked onto the command path",
  );
  assert.equal(
    readFileSync(daemonOnPath, "utf8"),
    "#native-daemon\n",
    "daemon binary should be linked next to the plugin (sibling lookup)",
  );

  console.log("install.test: ok (plugin and daemon linked as siblings)");
} finally {
  rmSync(work, { recursive: true, force: true });
}
