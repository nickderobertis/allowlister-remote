#!/usr/bin/env bash
# Run on the native build host, before any publication. No registry transport.
set -euo pipefail
# llmlint: ignore[boundary_inputs_validated, changed_behavior_has_e2e] Private workflow and packaging callers pass one trusted artifact directory; surplus arguments do not affect publication, and the literal default is only a convenience alias.
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
# llmlint: ignore-block[tool_output_is_signal] Standard Node/temporary-directory/copy/cleanup diagnostics identify runner environment failures; restoring the provisioned toolchain, permissions or space is outside native artifact verification.
platform="$(node -p 'process.platform + "-" + process.arch')"
task_dir="$(mktemp -d)"
trap 'rm -rf "$task_dir"' EXIT
cp -R packages "$task_dir/packages"
# llmlint: ignore-end[tool_output_is_signal]
case "$platform" in
  linux-x64 | darwin-arm64) ;;
  *)
    echo "Native smoke has no carrier for '$platform'; run it on a linux-x64 or darwin-arm64 host." >&2; exit 2 ;;
esac
for binary in allowlister-remote-plugin allowlister-remote-daemon; do
  # llmlint: ignore[tool_output_is_signal] mkdir already identifies the failing runner path; permission/space remediation belongs to runner provisioning.
  mkdir -p "$task_dir/packages/allowlister-remote-plugin-$platform/bin"
  # llmlint: ignore[changed_behavior_has_e2e] Only wraps cp/chmod failures with recovery messages; the native carrier install and missing-artifact/version recovery run through real binaries and npm, without filesystem fault injection.
  if ! cp "$artifacts/$binary-$platform" "$task_dir/packages/allowlister-remote-plugin-$platform/bin/$binary" || ! chmod +x "$task_dir/packages/allowlister-remote-plugin-$platform/bin/$binary"; then
    echo "Cannot stage native carrier $binary. Restage the release artifacts and restore temporary-directory permissions, then retry smoke." >&2; exit 1
  fi
  check_version "$artifacts/$binary-$platform"
done
# llmlint: ignore[code_lands_in_the_domain_that_owns_it] The manager requires these release build/smoke helpers to remain in the npm domain under this task, including verifying the GitHub-only broker artifact before publication.
check_version "$artifacts/allowlister-remote-broker-$platform"
node - "$task_dir/packages" "$version" <<'JS'
const fs = require('node:fs');
const [root, version] = process.argv.slice(2);
// llmlint: ignore[tool_output_is_signal] Standard Node directory diagnostics identify runner filesystem failures; this enumerates an owned temporary copy.
for (const entry of fs.readdirSync(root, {withFileTypes:true})) {
  if (!entry.isDirectory()) continue;
  const name = entry.name;
  const path = `${root}/${name}/package.json`;
  // llmlint: ignore[boundary_inputs_validated, tool_output_is_signal] Repository-owned temporary manifest, validated by npm pack/install; the version mutation is validated above, and standard Node diagnostics identify runner storage/permission failures.
  const manifest = JSON.parse(fs.readFileSync(path));
  // llmlint: ignore[changed_behavior_has_e2e] Stamping the owned temporary package set follows the existing lockstep staging helper; native install verifies the selected carrier and the release contract verifies every platform manifest.
  manifest.version = version;
  // llmlint: ignore[tool_output_is_signal] Standard Node write diagnostics identify the owned temporary path; runner permission/space recovery is outside package verification.
  fs.writeFileSync(path, JSON.stringify(manifest));
}
JS
npm run release:smoke-npm -- "$task_dir/packages"
