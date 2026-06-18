#!/usr/bin/env bash
set -euo pipefail

package_dir="${1:-./packages/allowlister-remote-plugin}"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
export npm_config_cache="${npm_config_cache:-$tmp_dir/npm-cache}"

npm pack "$package_dir" --pack-destination "$tmp_dir" --silent >/dev/null
tarball="$(find "$tmp_dir" -maxdepth 1 -name "*.tgz" -print -quit)"
if [[ -z "$tarball" ]]; then
  echo "npm package smoke: npm pack did not produce a tarball" >&2
  exit 1
fi

npm install --prefix "$tmp_dir/prefix" -g "$tarball" --silent
"$tmp_dir/prefix/bin/allowlister-remote-plugin" --version >/dev/null
printf '{"current_verdict":"allow","command":"git status","cwd":"/tmp"}' \
  | "$tmp_dir/prefix/bin/allowlister-remote-plugin" --server-url http://127.0.0.1:9 \
  | grep '"verdict":"defer"' >/dev/null

echo "npm package smoke: ok"
