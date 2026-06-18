#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

const [, , artifactsDir = "dist/release-artifacts"] = process.argv;
const packageDir = "packages/allowlister-remote-plugin";
const vendorDir = join(packageDir, "vendor");

const expectedArtifacts = [
  ["allowlister-remote-plugin-darwin-arm64", "darwin-arm64", "allowlister-remote-plugin"],
  ["allowlister-remote-plugin-linux-x64", "linux-x64", "allowlister-remote-plugin"],
  ["allowlister-remote-plugin-win32-x64.exe", "win32-x64", "allowlister-remote-plugin.exe"],
];

rmSync(vendorDir, { force: true, recursive: true });

for (const [artifactName, platformDir, outputName] of expectedArtifacts) {
  const artifactPath = findArtifact(artifactsDir, artifactName);
  const outputDir = join(vendorDir, platformDir);
  mkdirSync(outputDir, { recursive: true });
  cpSync(artifactPath, join(outputDir, outputName));
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

console.log(`staged ${expectedArtifacts.length} native binaries in ${basename(vendorDir)}`);
