#!/usr/bin/env bash
# allowlister-remote local setup — make a fresh machine ready to run the quality
# gate (lint, unit tests, build, and the Playwright e2e suite).
#
# Idempotent and safe to re-run. It:
#   1. ensures `just` (the task runner) is installed,
#   2. installs the JS + Rust workspace dependencies via `just bootstrap`,
#   3. installs the Playwright browsers the e2e suite needs (best-effort),
#   4. records a setup stamp for the fast session check.
#
# Node.js and the Rust toolchain (cargo) are assumed to be present already: this
# repo pins neither via asdf, so the base image / your machine provides them.
#
# Fresh machine (no `just` yet):  ./scripts/setup.sh
# Once `just` is available:        just setup
set -eu

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/setup-lib.sh
. scripts/setup-lib.sh
_load_tool_env

say()  { printf '» %s\n' "$*"; }
ok()   { printf '✓ %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

require_bin() {
  have "$1" && return
  printf 'error: %s is required but was not found on PATH. %s\n' "$1" "$2" >&2
  exit 1
}

# Install `just` without assuming a package manager: prefer the official prebuilt
# installer (fast, no compile), fall back to building from source via cargo on a
# network where the prebuilt is unreachable.
ensure_just() {
  if have just; then
    ok "just present ($(just --version 2>/dev/null || echo unknown))"
    return
  fi
  mkdir -p "$HOME/.local/bin"
  if have curl; then
    say "installing just into ~/.local/bin (prebuilt)"
    curl --proto '=https' --tlsv1.2 -sSf https://just.systems/install.sh \
      | bash -s -- --to "$HOME/.local/bin" 2>/dev/null || true
    _load_tool_env
  fi
  if ! have just; then
    say "prebuilt just unreachable — building from source (cargo install just)"
    cargo install --locked just
    _load_tool_env
  fi
  have just || { printf 'error: failed to install just\n' >&2; exit 1; }
  ok "just installed ($(just --version 2>/dev/null || echo unknown))"
}

main() {
  require_bin node  "Install Node.js (the version targeted by package.json)."
  require_bin npm   "Install npm (ships with Node.js)."
  require_bin cargo "Install the Rust toolchain via https://rustup.rs."
  ensure_just

  say "installing JS + Rust dependencies (just bootstrap)"
  just bootstrap

  # Playwright browsers power the e2e suite. Best-effort: a restricted network
  # must not fail the whole setup, since lint, unit tests, and build all still
  # work without the browsers.
  say "installing Playwright browsers (best-effort)"
  if npx --no-install playwright --version >/dev/null 2>&1; then
    if npx playwright install chromium >/dev/null 2>&1; then
      ok "Playwright chromium installed"
    else
      printf '! Playwright browser install failed (e2e may not run); rerun `npx playwright install` later.\n'
    fi
  else
    printf '! Playwright not found in node_modules; skipping browser install.\n'
  fi

  _write_stamp
  rm -f .dev/setup.failed 2>/dev/null || true
  ok "setup complete — stamp written to ${STAMP}"
  printf '\nReady: run `just check`, `just test`, or `just lint`.\n'
}

main "$@"
