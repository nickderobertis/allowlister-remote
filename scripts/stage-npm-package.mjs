#!/usr/bin/env node

// Stage the release-built native binaries into the per-platform npm packages.
//
// Each platform package ships two native binaries at `bin/`: the plugin and the
// daemon it auto-starts. At publish time the parent
// `@nickderobertis/allowlister-remote-plugin` package declares these as optional
// dependencies, so npm installs only the one matching the host and links both
// binaries directly onto the command path (the daemon as a sibling of the
// plugin, where the plugin resolves it).

import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const [, , artifactsDir = "dist/release-artifacts"] = process.argv;
const packagesDir = "packages";

// Each platform ships both the plugin and the daemon; `suffix` is the platform's
// executable extension (`.exe` on Windows, empty elsewhere).
const platforms = [
  { pkg: "allowlister-remote-plugin-darwin-arm64", target: "darwin-arm64", suffix: "" },
  { pkg: "allowlister-remote-plugin-linux-x64", target: "linux-x64", suffix: "" },
  { pkg: "allowlister-remote-plugin-win32-x64", target: "win32-x64", suffix: ".exe" },
];
let stagedCount = 0;
for (const { pkg, target, suffix } of platforms) {
  const binDir = join(packagesDir, pkg, "bin");
  rmSync(binDir, { force: true, recursive: true });
  mkdirSync(binDir, { recursive: true });
  // The daemon is built on Unix domain sockets, so it is Unix-only; Windows ships
  // the plugin alone and uses its HTTP path.
  const binaries =
    target === "win32-x64"
      ? ["allowlister-remote-plugin"]
      : ["allowlister-remote-plugin", "allowlister-remote-daemon"];
  for (const binary of binaries) {
    const artifact = `${binary}-${target}${suffix}`;
    const artifactPath = findArtifact(artifactsDir, artifact);
    const outputPath = join(binDir, `${binary}${suffix}`);
    cpSync(artifactPath, outputPath);
    if (suffix !== ".exe") {
      chmodSync(outputPath, 0o755);
    }
    stagedCount += 1;
  }
}

function findArtifact(root, name) {
  const directPath = join(root, name);
  if (existsSync(directPath)) {
    return directPath;
  }

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const nestedPath = join(root, entry.name, name);
    if (existsSync(nestedPath)) {
      return nestedPath;
    }
  }

  throw new Error(`Missing release artifact ${name} under ${root}`);
}

console.log(`staged ${stagedCount} native binaries into per-platform packages`);
