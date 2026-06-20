#!/usr/bin/env bash
# Pre-publish smoke for the per-platform npm packaging.
#
# Installs the parent `@nickderobertis/allowlister-remote-plugin` package the way
# a user would, but resolving this host's platform package from a locally packed
# tarball instead of the registry (the version under test is not published yet).
# Verifies that the install links the native Rust binary directly onto the
# command path -- i.e. the `allowlister-remote-plugin` command is the executable
# itself, with no Node launcher in the hot path.
set -euo pipefail

packages_root="${1:-packages}"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
export npm_config_cache="${npm_config_cache:-$tmp_dir/npm-cache}"

platform="$(node -e 'process.stdout.write(process.platform + "-" + process.arch)')"
case "$platform" in
  linux-x64) plat_pkg="allowlister-remote-plugin-linux-x64" ;;
  darwin-arm64) plat_pkg="allowlister-remote-plugin-darwin-arm64" ;;
  win32-x64) plat_pkg="allowlister-remote-plugin-win32-x64" ;;
  *) echo "npm package smoke: unsupported platform $platform" >&2; exit 1 ;;
esac

# Pack this host's platform package (it must already have its staged binary).
plat_tgz="$(cd "$packages_root/$plat_pkg" && npm pack --silent --pack-destination "$tmp_dir")"

# Copy the parent package and point this host's optional dependency at the local
# platform tarball so the install does not reach for the registry. The committed
# parent has no optionalDependencies (they are injected at publish time), so add
# just this host's entry here.
cp -r "$packages_root/allowlister-remote-plugin" "$tmp_dir/parent"
node -e '
  const fs = require("node:fs");
  const [path, name, tgz] = process.argv.slice(1);
  const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
  delete manifest["//optionalDependencies"];
  manifest.optionalDependencies = {
    ...(manifest.optionalDependencies ?? {}),
    [name]: `file:${tgz}`,
  };
  fs.writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
' "$tmp_dir/parent/package.json" "@nickderobertis/$plat_pkg" "$tmp_dir/$plat_tgz"

parent_tgz="$(cd "$tmp_dir/parent" && npm pack --silent --pack-destination "$tmp_dir")"

npm install --prefix "$tmp_dir/prefix" -g "$tmp_dir/$parent_tgz" --silent

cmd="$tmp_dir/prefix/bin/allowlister-remote-plugin"
"$cmd" --version >/dev/null
printf '{"current_verdict":"allow","command":"git status","project":"/tmp"}' \
  | "$cmd" --server-url http://127.0.0.1:9 \
  | grep '"verdict":"defer"' >/dev/null

# The command on PATH must be the native binary itself, not the JS launcher
# (which begins with a `#!` shebang). Windows keeps the launcher by design.
if [[ "$platform" != win32-* ]]; then
  target="$(node -e 'console.log(require("node:fs").realpathSync(process.argv[1]))' "$cmd")"
  if [[ "$(head -c 2 "$target")" == "#!" ]]; then
    echo "npm package smoke: command on PATH is still the JS launcher, expected the native binary" >&2
    exit 1
  fi

  # The daemon must be installed as a sibling of the RESOLVED plugin binary
  # (current_exe() follows the bin symlink) so the plugin's `resolve_daemon_bin`
  # sibling lookup finds it (it auto-starts the daemon).
  daemon="$(dirname "$target")/allowlister-remote-daemon"
  if [[ ! -x "$daemon" ]]; then
    echo "npm package smoke: daemon binary missing next to the plugin on PATH" >&2
    exit 1
  fi
  "$daemon" --version >/dev/null
fi

echo "npm package smoke: ok (native plugin and daemon binaries on PATH)"
