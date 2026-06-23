#!/usr/bin/env node

// Stage the static Next.js export into the @nickderobertis/allowlister-remote-web
// npm package: stamp the version from the git tag and vendor the exported assets
// into the package's `static/` directory (which is gitignored and only populated
// at publish time).

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [, , version, sourceDir = "apps/web/out"] = process.argv;

const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function usage(message) {
  process.stderr.write(`${message}\n`);
  process.stderr.write("usage: node scripts/stage-web-package.mjs <version> [sourceDir]\n");
  process.exit(1);
}

if (!version || !VERSION_RE.test(version)) {
  usage(`invalid or missing <version>: ${JSON.stringify(version)}`);
}

if (!existsSync(sourceDir)) {
  usage(`source directory does not exist: ${sourceDir} (did you build the static export?)`);
}

const packageDir = join("packages", "allowlister-remote-web");
const pkgPath = join(packageDir, "package.json");
const staticDir = join(packageDir, "static");

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.version = version;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

rmSync(staticDir, { force: true, recursive: true });
mkdirSync(staticDir, { recursive: true });
cpSync(sourceDir, staticDir, { recursive: true });

process.stdout.write(`staged web PWA ${version} from ${sourceDir}\n`);
