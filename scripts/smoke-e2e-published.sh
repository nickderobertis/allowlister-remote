#!/usr/bin/env bash
# Post-publish end-to-end smoke test.
#
# Installs the published npm plugin package from the public npm registry and
# drives the full browser approval flow (real allowlister binary -> published
# plugin process -> built Next.js app over HTTP -> Playwright) against it.
#
# Unlike the in-repo e2e suite, the plugin binary under test is the one that was
# just published to npm, not a locally built debug binary. The Next.js app is
# built from the current checkout because the server is deployed from source.
set -euo pipefail

package="@nickderobertis/allowlister-remote-plugin"
version="${1:-}"
if [[ -z "$version" ]]; then
  version="$(npm view "$package" version)"
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
export npm_config_cache="${npm_config_cache:-$tmp_dir/npm-cache}"

echo "smoke-e2e: installing published $package@$version from the public npm registry"
installed=0
for attempt in {1..12}; do
  if npm install --prefix "$tmp_dir/prefix" -g "$package@$version"; then
    installed=1
    break
  fi
  echo "smoke-e2e: install attempt $attempt failed; waiting for registry propagation"
  sleep 10
done
if [[ "$installed" -ne 1 ]]; then
  echo "smoke-e2e: failed to install $package@$version" >&2
  exit 1
fi

plugin_bin="$tmp_dir/prefix/bin/allowlister-remote-plugin"
actual="$("$plugin_bin" --version)"
if [[ "$actual" != "$version" ]]; then
  echo "smoke-e2e: published binary reports version '$actual', expected '$version'" >&2
  exit 1
fi

export ALLOWLISTER_REMOTE_PLUGIN_BIN="$plugin_bin"
echo "smoke-e2e: running Playwright approval flow against the published plugin binary"
(cd apps/web && npx playwright test --config playwright.config.ts)

echo "smoke-e2e: ok"
