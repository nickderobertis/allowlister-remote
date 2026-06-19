# Shared helpers for the local-setup scripts (setup.sh, setup-check.sh) and the
# session hook (session-setup.sh). Sourced, not executed: callers set their own
# `set -eu`. All functions assume the current directory is the repo root.

# Binaries that must resolve for the dev environment to be considered ready: the
# JS runtime + package manager (node/npm), the Rust toolchain (cargo), and the
# task runner (just). node_modules / cargo deps readiness is captured by the
# setup stamp rather than a binary check.
REQUIRED_BINS="node npm cargo just"

# Soft requirements: their absence is an advisory, never a "not ready" verdict.
# The Playwright browsers only matter for the e2e suite; building, linting, and
# unit tests all work without them, so they never block readiness here.

# Machine-local setup state. Lives at the repo root under .dev/ (gitignored) so a
# clean of build artifacts (target/, .next/, dist/) does not un-provision the
# machine.
STAMP=".dev/setup.stamp"

# Put the installed toolchains on PATH for this process. A non-interactive shell
# (and some hook contexts) does not source the user's rc, so cargo/just binaries
# may be installed yet unresolved; this normalises that without requiring a fresh
# login. Idempotent and safe when nothing is installed.
_load_tool_env() {
  [ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
  # Prebuilt installers (just) land in ~/.local/bin; cargo-installed bins in
  # ~/.cargo/bin. Add both ahead of $PATH when present.
  local d
  for d in "$HOME/.local/bin" "$HOME/.cargo/bin"; do
    [ -d "$d" ] || continue
    case ":$PATH:" in
      *":$d:"*) : ;;
      *) PATH="$d:$PATH"; export PATH ;;
    esac
  done
}

# SHA-256 of stdin using whatever tool is available; a stable sentinel if none
# is (so the stamp comparison still works, falling back to binary-presence only).
_sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 | awk '{print $NF}'
  else
    printf 'no-sha256-tool\n'
  fi
}

# Fingerprint of the inputs that setup depends on: the JS and Rust lockfiles and
# the justfile. A change to any of these invalidates the stamp so setup re-runs
# (e.g. after a dependency bump or `just upgrade`).
_fingerprint() {
  {
    [ -f package-lock.json ] && cat package-lock.json
    [ -f Cargo.lock ] && cat Cargo.lock
    [ -f justfile ] && cat justfile
  } 2>/dev/null | _sha256_stdin
}

# Echo the subset of $1 (a space-separated list of binary names) that does not
# resolve on PATH, each prefixed with a space; empty when all resolve.
_missing_bins() {
  local b out=""
  for b in $1; do
    command -v "$b" >/dev/null 2>&1 || out="$out $b"
  done
  printf '%s' "$out"
}

# Is the dev environment ready? Returns 0 when every required binary resolves and
# the stamp matches the current fingerprint; otherwise returns 1 and sets REASON.
_check_ready() {
  REASON=""
  local missing
  missing="$(_missing_bins "$REQUIRED_BINS")"
  if [ -n "$missing" ]; then
    REASON="missing tools:$missing"
    return 1
  fi
  local want have_fp
  want="$(_fingerprint)"
  have_fp="$(cat "$STAMP" 2>/dev/null || true)"
  if [ -z "$have_fp" ]; then
    REASON="no setup stamp (first run on this machine)"
    return 1
  fi
  if [ "$want" != "$have_fp" ]; then
    REASON="dependency lockfiles or justfile changed since last setup"
    return 1
  fi
  return 0
}

# Record the current fingerprint as the stamp of a successful setup.
_write_stamp() {
  mkdir -p "$(dirname "$STAMP")"
  _fingerprint > "$STAMP"
}
