// Post-install step: link the native binaries directly onto the command path.
//
// npm has already installed the one platform package that matches this host
// (the others are skipped by their `os`/`cpu` fields). On macOS and Linux we
// copy that native binary over the JS launcher at `bin/allowlister-remote-plugin`,
// which is the file the `allowlister-remote-plugin` command symlinks to. After
// this the command on PATH is the Rust executable itself -- no Node process is
// spawned per invocation, which matters because allowlister can call the plugin
// hundreds of times in a single agent session.
//
// We also drop the `allowlister-remote-daemon` binary next to it in the same
// `bin/` directory so the plugin's sibling lookup (`resolve_daemon_bin`) finds
// the daemon it auto-starts without it having to be separately on PATH.
//
// On Windows npm generates `.cmd`/`.ps1` shims that invoke the launcher through
// Node, so replacing the target in place would break them; we keep the JS
// launcher there instead. Either way, if anything goes wrong we leave the
// launcher in place as a working fallback and never fail the install.

import { chmodSync, copyFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { binarySpecifier, daemonSpecifier } from "./lib/platform.mjs";

const require = createRequire(import.meta.url);
// Resolve symlinks so a workspace link does not make us look like an install.
const here = realpathSync(dirname(fileURLToPath(import.meta.url)));

// When this package lives in its source monorepo (linked as a workspace rather
// than installed under node_modules), overwriting the launcher would clobber the
// committed source file. Detect that by walking up to a `workspaces`-bearing
// package.json without first crossing a `node_modules` boundary.
function inWorkspaceCheckout(startDir) {
  let dir = startDir;
  for (;;) {
    if (basename(dir) === "node_modules") {
      return false;
    }
    const manifestPath = join(dir, "package.json");
    if (existsSync(manifestPath)) {
      try {
        if (JSON.parse(readFileSync(manifestPath, "utf8")).workspaces) {
          return true;
        }
      } catch {
        // Ignore unreadable/partial manifests and keep walking up.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return false;
    }
    dir = parent;
  }
}

if (inWorkspaceCheckout(here)) {
  console.log("allowlister-remote-plugin: source checkout detected, keeping the JS launcher");
} else {
  try {
    const native = require.resolve(binarySpecifier());

    if (process.platform === "win32") {
      console.log(
        "allowlister-remote-plugin: keeping the JS launcher (required by npm shims on Windows)",
      );
    } else {
      const onPath = join(here, "bin", "allowlister-remote-plugin");
      copyFileSync(native, onPath);
      chmodSync(onPath, 0o755);
      // Place the daemon next to the plugin so its sibling lookup succeeds.
      const daemon = require.resolve(daemonSpecifier());
      const daemonOnPath = join(here, "bin", "allowlister-remote-daemon");
      copyFileSync(daemon, daemonOnPath);
      chmodSync(daemonOnPath, 0o755);
      console.log(
        "allowlister-remote-plugin: linked the native plugin and daemon binaries directly onto the command path",
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`allowlister-remote-plugin: keeping the JS launcher fallback (${message})`);
  }
}
