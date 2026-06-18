#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const version = process.argv[2] ?? process.env.ALLOWLISTER_REMOTE_VERSION;

if (!version || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("usage: node scripts/set-npm-package-version.mjs <semver>");
  process.exit(1);
}

execFileSync(
  "npm",
  [
    "version",
    "--workspace",
    "@nickderobertis/allowlister-remote-plugin",
    "--no-git-tag-version",
    version,
  ],
  { stdio: "inherit" },
);
