#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const supportedPlatforms = new Map([
  ["darwin-arm64", "darwin-arm64/allowlister-remote-plugin"],
  ["darwin-x64", "darwin-x64/allowlister-remote-plugin"],
  ["linux-x64", "linux-x64/allowlister-remote-plugin"],
  ["win32-x64", "win32-x64/allowlister-remote-plugin.exe"],
]);

export function nativeBinaryPath(platform = process.platform, arch = process.arch) {
  const relativePath = supportedPlatforms.get(`${platform}-${arch}`);
  if (!relativePath) {
    throw new Error(`Unsupported platform: ${platform}-${arch}`);
  }

  return join(dirname(fileURLToPath(import.meta.url)), "..", "vendor", relativePath);
}

function main() {
  const binary = nativeBinaryPath();

  if (!existsSync(binary)) {
    console.error(
      `Missing native allowlister-remote-plugin binary for ${process.platform}-${process.arch}.`,
    );
    process.exit(1);
  }

  const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  process.exit(result.status ?? 1);
}

function isMainModule() {
  if (!process.argv[1]) {
    return false;
  }

  return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  main();
}
