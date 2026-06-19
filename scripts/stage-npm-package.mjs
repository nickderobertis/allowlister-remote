#!/usr/bin/env node

// Stage the release-built native binaries into the per-platform npm packages.
//
// Each platform package ships exactly one native binary at `bin/`. At publish
// time the parent `@nickderobertis/allowlister-remote-plugin` package declares
// these as optional dependencies, so npm installs only the one matching the
// host and links its binary directly onto the command path.

import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const [, , artifactsDir = "dist/release-artifacts"] = process.argv;
const packagesDir = "packages";

const platforms = [
  {
    artifact: "allowlister-remote-plugin-darwin-arm64",
    pkg: "allowlister-remote-plugin-darwin-arm64",
    binary: "allowlister-remote-plugin",
  },
  {
    artifact: "allowlister-remote-plugin-linux-x64",
    pkg: "allowlister-remote-plugin-linux-x64",
    binary: "allowlister-remote-plugin",
  },
  {
    artifact: "allowlister-remote-plugin-win32-x64.exe",
    pkg: "allowlister-remote-plugin-win32-x64",
    binary: "allowlister-remote-plugin.exe",
  },
];

for (const { artifact, pkg, binary } of platforms) {
  const artifactPath = findArtifact(artifactsDir, artifact);
  const binDir = join(packagesDir, pkg, "bin");
  rmSync(binDir, { force: true, recursive: true });
  mkdirSync(binDir, { recursive: true });
  const outputPath = join(binDir, binary);
  cpSync(artifactPath, outputPath);
  if (!binary.endsWith(".exe")) {
    chmodSync(outputPath, 0o755);
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

console.log(`staged ${platforms.length} native binaries into per-platform packages`);
