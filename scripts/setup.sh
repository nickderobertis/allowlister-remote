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

# screencomp powers the pre-push visual guard (.githooks/pre-push): it classifies
# captured screenshots against the committed baseline. Best-effort like the
# Playwright browsers — a restricted network must not fail setup, since the guard
# simply skips when the CLI is absent and CI still gates visual drift.
# Pinned to the same release the visual-docs CI workflow uses, so local captures
# classify with the identical tool. Pinning also skips the install script's
# "resolve latest" GitHub API call, which is rate-limited for unauthenticated
# requests. Override with SCREENCOMP_VERSION.
SCREENCOMP_VERSION="${SCREENCOMP_VERSION:-v0.3.0}"
ensure_screencomp() {
  if have screencomp; then
    ok "screencomp present ($(screencomp --version 2>/dev/null || echo unknown))"
    return
  fi
  mkdir -p "$HOME/.local/bin"
  if have curl; then
    say "installing screencomp ${SCREENCOMP_VERSION} into ~/.local/bin (prebuilt)"
    curl -fsSL https://raw.githubusercontent.com/nickderobertis/screencomp/main/scripts/install.sh \
      | sh -s -- --to "$HOME/.local/bin" --version "$SCREENCOMP_VERSION" 2>/dev/null || true
    _load_tool_env
  fi
  if ! have screencomp && have cargo; then
    say "prebuilt screencomp unreachable — building from source (cargo install --git)"
    cargo install --git https://github.com/nickderobertis/screencomp --tag "$SCREENCOMP_VERSION" \
      --locked screencomp 2>/dev/null || true
    _load_tool_env
  fi
  if have screencomp; then
    ok "screencomp installed ($(screencomp --version 2>/dev/null || echo unknown))"
  else
    printf '! screencomp not installed (the pre-push visual guard will skip); rerun setup with network access.\n'
  fi
}

# Activate the repo's git hooks so the pre-push visual guard runs. Idempotent;
# the guard itself only captures when screenshot-relevant files change and is a
# no-op under CI. Bypass an individual push with `git push --no-verify`.
enable_git_hooks() {
  [ -d .githooks ] || return 0
  if [ "$(git config core.hooksPath 2>/dev/null || true)" = ".githooks" ]; then
    ok "git hooks already enabled (core.hooksPath=.githooks)"
    return
  fi
  if git config core.hooksPath .githooks 2>/dev/null; then
    ok "enabled git hooks (core.hooksPath=.githooks)"
  fi
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

  # Visual-regression guard: the screencomp CLI + the git hook that runs it on a
  # screenshot-relevant push. The hook starts Docker lazily (remote env) only
  # when a capture is actually needed.
  ensure_screencomp
  enable_git_hooks

  _write_stamp
  rm -f .dev/setup.failed 2>/dev/null || true
  ok "setup complete — stamp written to ${STAMP}"
  printf '\nReady: run `just check`, `just test`, or `just lint`.\n'
}

main "$@"
