// Shared resolution for the per-platform native binary packages.
//
// Each supported platform ships the native `allowlister-remote-plugin` binary in
// its own npm package (declared as an optional dependency of this package). npm
// installs only the package whose `os`/`cpu` match the host, so resolving the
// binary is a matter of mapping the running platform/arch onto that package and
// asking Node where it landed in `node_modules`.

const PLATFORM_PACKAGES = new Map([
  [
    "darwin-arm64",
    { pkg: "allowlister-remote-plugin-darwin-arm64", file: "allowlister-remote-plugin" },
  ],
  ["linux-x64", { pkg: "allowlister-remote-plugin-linux-x64", file: "allowlister-remote-plugin" }],
  [
    "win32-x64",
    { pkg: "allowlister-remote-plugin-win32-x64", file: "allowlister-remote-plugin.exe" },
  ],
]);

const SCOPE = "@nickderobertis";

/**
 * Describe the platform package for a given platform/arch, throwing for any
 * combination we do not publish a binary for.
 */
export function platformPackage(platform = process.platform, arch = process.arch) {
  const entry = PLATFORM_PACKAGES.get(`${platform}-${arch}`);
  if (!entry) {
    throw new Error(`Unsupported platform: ${platform}-${arch}`);
  }
  return { name: `${SCOPE}/${entry.pkg}`, file: entry.file };
}

/**
 * The bare specifier Node uses to locate the native binary inside the installed
 * platform package, e.g. `@nickderobertis/allowlister-remote-plugin-linux-x64/bin/allowlister-remote-plugin`.
 */
export function binarySpecifier(platform = process.platform, arch = process.arch) {
  const { name, file } = platformPackage(platform, arch);
  return `${name}/bin/${file}`;
}

/**
 * Resolve the absolute path to the native binary using the caller's `require`
 * (created with `createRequire(import.meta.url)`). Throws if the matching
 * platform package is not installed.
 */
export function resolveNativeBinary(require, platform = process.platform, arch = process.arch) {
  return require.resolve(binarySpecifier(platform, arch));
}
