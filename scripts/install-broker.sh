#!/usr/bin/env bash
# Install the standalone allowlister-remote broker CLI from a GitHub Release.
#
# The broker is the WebSocket relay that mediates approvals between the daemon
# (plugin side) and the PWA. Unlike the plugin and daemon — which ship on npm —
# the broker is server-side, so it is distributed only as a native binary on the
# repository's GitHub Releases, the same way `nickderobertis/allowlister` ships
# its CLI. This script detects the host platform, resolves a release, downloads
# the matching binary plus `SHA256SUMS`, verifies the checksum, and installs the
# binary onto a bin directory.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/nickderobertis/allowlister-remote/main/scripts/install-broker.sh | bash
#   ... | bash -s -- --version v0.10.0 --bin-dir /usr/local/bin
#
# Flags / environment:
#   --version <tag>        Release tag to install (default: latest). Env: ALLOWLISTER_REMOTE_BROKER_VERSION
#   --bin-dir <dir>        Install directory (default: ~/.local/bin). Env: ALLOWLISTER_REMOTE_BROKER_INSTALL_DIR
#   GITHUB_TOKEN           Optional; authenticates the GitHub API "latest release" lookup to dodge rate limits.
set -euo pipefail

REPO="nickderobertis/allowlister-remote"
BINARY="allowlister-remote-broker"
VERSION="${ALLOWLISTER_REMOTE_BROKER_VERSION:-}"
BIN_DIR="${ALLOWLISTER_REMOTE_BROKER_INSTALL_DIR:-$HOME/.local/bin}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      VERSION="${2:-}"
      shift 2
      ;;
    --bin-dir)
      BIN_DIR="${2:-}"
      shift 2
      ;;
    -h | --help)
      sed -n '2,22p' "$0"
      exit 0
      ;;
    *)
      echo "install-broker: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

die() {
  echo "install-broker: $*" >&2
  exit 1
}

# Map `uname` output to the platform string used in the release asset names
# (`allowlister-remote-broker-<platform>[.exe]`), matching publish.yml.
detect_platform() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Linux)
      [[ "$arch" == "x86_64" || "$arch" == "amd64" ]] || die "unsupported Linux arch: $arch (only x86_64 is published)"
      echo "linux-x64"
      ;;
    Darwin)
      [[ "$arch" == "arm64" || "$arch" == "aarch64" ]] || die "unsupported macOS arch: $arch (only arm64 is published)"
      echo "darwin-arm64"
      ;;
    MINGW* | MSYS* | CYGWIN* | Windows_NT)
      echo "win32-x64"
      ;;
    *)
      die "unsupported OS: $os"
      ;;
  esac
}

# Pick the available checksum tool. The release publishes raw binaries plus a
# single SHA256SUMS manifest, so any one of these can verify the download.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  else
    die "need one of sha256sum, shasum, or openssl to verify the download"
  fi
}

command -v curl >/dev/null 2>&1 || die "curl is required"

PLATFORM="$(detect_platform)"
EXE=""
[[ "$PLATFORM" == "win32-x64" ]] && EXE=".exe"
ASSET="${BINARY}-${PLATFORM}${EXE}"

# Resolve the latest release tag when none was requested. Authenticate the API
# call when GITHUB_TOKEN is set; unauthenticated calls are rate-limited on shared
# CI IPs.
if [[ -z "$VERSION" ]]; then
  api="https://api.github.com/repos/${REPO}/releases/latest"
  auth=()
  [[ -n "${GITHUB_TOKEN:-}" ]] && auth=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
  VERSION="$(curl -fsSL "${auth[@]}" "$api" | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')"
  [[ -n "$VERSION" ]] || die "could not resolve the latest release tag (set --version explicitly)"
fi

BASE="https://github.com/${REPO}/releases/download/${VERSION}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "install-broker: downloading ${ASSET} (${VERSION})"
curl -fsSL "${BASE}/${ASSET}" -o "${tmp}/${ASSET}" || die "failed to download ${ASSET} for ${VERSION}"
curl -fsSL "${BASE}/SHA256SUMS" -o "${tmp}/SHA256SUMS" || die "failed to download SHA256SUMS for ${VERSION}"

expected="$(awk -v name="$ASSET" '$2 == name || $2 == "*"name {print $1}' "${tmp}/SHA256SUMS")"
[[ -n "$expected" ]] || die "SHA256SUMS has no entry for ${ASSET}"
actual="$(sha256_of "${tmp}/${ASSET}")"
[[ "$expected" == "$actual" ]] || die "checksum mismatch for ${ASSET} (expected ${expected}, got ${actual})"

mkdir -p "$BIN_DIR"
install -m 0755 "${tmp}/${ASSET}" "${BIN_DIR}/${BINARY}${EXE}"
echo "install-broker: installed ${BINARY}${EXE} to ${BIN_DIR}"

case ":${PATH}:" in
  *":${BIN_DIR}:"*) ;;
  *) echo "install-broker: note: ${BIN_DIR} is not on your PATH; add it to run '${BINARY}' directly" >&2 ;;
esac

"${BIN_DIR}/${BINARY}${EXE}" --version >/dev/null 2>&1 \
  && echo "install-broker: ${BINARY} $(${BIN_DIR}/${BINARY}${EXE} --version) ready" \
  || echo "install-broker: installed, but '${BINARY} --version' did not run cleanly" >&2
