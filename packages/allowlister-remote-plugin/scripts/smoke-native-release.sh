#!/usr/bin/env bash
# Run on the native build host, before any publication. No registry transport.
set -euo pipefail
# llmlint: ignore[boundary_inputs_validated] Private workflow command supplies one artifact directory; surplus arguments do not change the selected build artifacts or publication route.
artifacts="${1:-dist/artifacts}"
version="${ALLOWLISTER_REMOTE_PLUGIN_VERSION:?Set ALLOWLISTER_REMOTE_PLUGIN_VERSION to the release tag without v}"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?(\+[A-Za-z0-9.-]+)?$ ]]; then
  echo "Invalid release version '$version'. Set ALLOWLISTER_REMOTE_PLUGIN_VERSION to the tag without v." >&2; exit 2
fi
check_version() {
  local binary="$1" actual
  # llmlint: ignore[boundary_inputs_validated] Private native smoke deliberately runs artifacts supplied by its trusted builder or local packaging fixtures; production fixes the directory to dist/artifacts.
  if ! actual="$("$binary" --version)"; then
    echo "Cannot execute $binary. Rebuild and restage the native artifact before retrying smoke." >&2; exit 1
  fi
  if [[ "$actual" != "$version" ]]; then
    echo "$binary version '$actual' differs from '$version'. Rebuild with ALLOWLISTER_REMOTE_PLUGIN_VERSION set to the release tag without v." >&2; exit 1
  fi
}
platform="$(node -p 'process.platform + "-" + process.arch')"
task_dir="$(mktemp -d)"
trap 'rm -rf "$task_dir"' EXIT
cp -R packages "$task_dir/packages"
for binary in allowlister-remote-plugin allowlister-remote-daemon; do
  mkdir -p "$task_dir/packages/allowlister-remote-plugin-$platform/bin"
  # llmlint: ignore[changed_behavior_has_e2e] Only wraps cp/chmod failures with recovery messages; the native carrier install and missing-artifact/version recovery run through real binaries and npm, without filesystem fault injection.
  if ! cp "$artifacts/$binary-$platform" "$task_dir/packages/allowlister-remote-plugin-$platform/bin/$binary" || ! chmod +x "$task_dir/packages/allowlister-remote-plugin-$platform/bin/$binary"; then
    echo "Cannot stage native carrier $binary. Restage the release artifacts and restore temporary-directory permissions, then retry smoke." >&2; exit 1
  fi
  check_version "$artifacts/$binary-$platform"
done
check_version "$artifacts/allowlister-remote-broker-$platform"
node - "$task_dir/packages" "$version" <<'JS'
const fs = require('node:fs');
const [root, version] = process.argv.slice(2);
for (const entry of fs.readdirSync(root, {withFileTypes:true})) {
  if (!entry.isDirectory()) continue;
  const name = entry.name;
  const path = `${root}/${name}/package.json`;
  // llmlint: ignore[boundary_inputs_validated] Repository-owned temporary manifest copy; npm pack/install validate its package structure, and the release-version mutation is validated above.
  const manifest = JSON.parse(fs.readFileSync(path));
  manifest.version = version;
  fs.writeFileSync(path, JSON.stringify(manifest));
}
JS
npm run release:smoke-npm -- "$task_dir/packages"
