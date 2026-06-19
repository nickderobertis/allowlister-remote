#!/usr/bin/env node

// Set the version on the parent npm package and every per-platform package, and
// pin the parent's optional dependencies to that exact version. Editing the
// package.json files directly (rather than `npm version`) keeps the parent's
// optionalDependencies in lockstep with the platform packages they point at.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const version = process.argv[2] ?? process.env.ALLOWLISTER_REMOTE_VERSION;

if (!version || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("usage: node scripts/set-npm-package-version.mjs <semver>");
  process.exit(1);
}

const packagesDir = "packages";
const parent = "allowlister-remote-plugin";
const platformPackages = [
  "allowlister-remote-plugin-darwin-arm64",
  "allowlister-remote-plugin-linux-x64",
  "allowlister-remote-plugin-win32-x64",
];

for (const dir of [parent, ...platformPackages]) {
  const path = join(packagesDir, dir, "package.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.version = version;

  if (dir === parent && manifest.optionalDependencies) {
    for (const name of Object.keys(manifest.optionalDependencies)) {
      manifest.optionalDependencies[name] = version;
    }
  }

  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

console.log(`set version ${version} across ${platformPackages.length + 1} packages`);
