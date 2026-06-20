// Shared resolution for the per-platform native binary packages.
//
// Each supported platform ships two native binaries in its own npm package
// (declared as an optional dependency of this package): the
// `allowlister-remote-plugin` binary and the `allowlister-remote-daemon` it
// auto-starts. npm installs only the package whose `os`/`cpu` match the host, so
// resolving a binary is a matter of mapping the running platform/arch onto that
// package and asking Node where it landed in `node_modules`. The `.exe`
// extension on Windows is appended per-binary via `suffix`.

const PLATFORM_PACKAGES = new Map([
  ["darwin-arm64", { pkg: "allowlister-remote-plugin-darwin-arm64", suffix: "" }],
  ["linux-x64", { pkg: "allowlister-remote-plugin-linux-x64", suffix: "" }],
  ["win32-x64", { pkg: "allowlister-remote-plugin-win32-x64", suffix: ".exe" }],
]);

const SCOPE = "@nickderobertis";

/**
 * Describe the platform package for a given platform/arch, throwing for any
 * combination we do not publish a binary for. `file` is the plugin binary's
 * name (with the platform's `.exe` suffix); `daemonFile` is the daemon's.
 */
export function platformPackage(platform = process.platform, arch = process.arch) {
  const entry = PLATFORM_PACKAGES.get(`${platform}-${arch}`);
  if (!entry) {
    throw new Error(`Unsupported platform: ${platform}-${arch}`);
  }
  return {
    name: `${SCOPE}/${entry.pkg}`,
    file: `allowlister-remote-plugin${entry.suffix}`,
    daemonFile: `allowlister-remote-daemon${entry.suffix}`,
  };
}

/**
 * The bare specifier Node uses to locate the native plugin binary inside the
 * installed platform package, e.g.
 * `@nickderobertis/allowlister-remote-plugin-linux-x64/bin/allowlister-remote-plugin`.
 */
export function binarySpecifier(platform = process.platform, arch = process.arch) {
  const { name, file } = platformPackage(platform, arch);
  return `${name}/bin/${file}`;
}

/**
 * The bare specifier Node uses to locate the native daemon binary inside the
 * installed platform package, e.g.
 * `@nickderobertis/allowlister-remote-plugin-linux-x64/bin/allowlister-remote-daemon`.
 */
export function daemonSpecifier(platform = process.platform, arch = process.arch) {
  const { name, daemonFile } = platformPackage(platform, arch);
  return `${name}/bin/${daemonFile}`;
}

/**
 * Resolve the absolute path to the native plugin binary using the caller's
 * `require` (created with `createRequire(import.meta.url)`). Throws if the
 * matching platform package is not installed.
 */
export function resolveNativeBinary(require, platform = process.platform, arch = process.arch) {
  return require.resolve(binarySpecifier(platform, arch));
}
