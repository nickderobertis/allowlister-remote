#!/usr/bin/env bash
# Claude Code SessionStart hook: keep the dev environment ready for tests + lint.
#
# Behaviour depends on where the session runs:
#   * Claude Code on the web (CLAUDE_CODE_REMOTE=true): when the environment is
#     not ready, provision it SYNCHRONOUSLY so the session starts with deps
#     installed. The remote container state is cached after the hook completes,
#     so this cost is paid once. Full output goes to .dev/setup.log; only a short
#     summary is injected as session context.
#   * Local: never block a multi-minute install — print guidance to run
#     `just setup` as a visible, interruptible first step. A ready environment
#     stays silent. Set ALLOWLISTER_AUTO_SETUP=1 to provision in the background
#     (detached, still non-blocking) instead of being advised.
set -eu

# Skip in this repo's own GitHub Actions CI (jobs provision explicitly). Escape
# hatch for any other automated context: ALLOWLISTER_SKIP_SETUP.
[ -n "${GITHUB_ACTIONS:-}" ] && exit 0
[ -n "${ALLOWLISTER_SKIP_SETUP:-}" ] && exit 0

ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT"
# shellcheck source=scripts/setup-lib.sh
. scripts/setup-lib.sh
_load_tool_env

# Ready -> stay silent and cheap.
_check_ready && exit 0

# Remote (Claude Code on the web): provision now, blocking session start so it
# begins ready. The container is cached afterwards, so future sessions are fast.
if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
  mkdir -p .dev
  printf '[allowlister-remote] Dev environment not ready (%s); provisioning now (log: .dev/setup.log)...\n' "${REASON}"
  if bash scripts/setup.sh >.dev/setup.log 2>&1; then
    printf '[allowlister-remote] Setup complete — `just check`, `just test`, and `just lint` are ready.\n'
  else
    : > .dev/setup.failed
    printf '[allowlister-remote] Setup FAILED; rerun `just setup` to retry. Last lines of .dev/setup.log:\n'
    tail -n 20 .dev/setup.log 2>/dev/null || true
  fi
  exit 0
fi

# Opt-in (local): provision hands-off, but DETACHED so the session is never
# blocked. A flock keeps two concurrent sessions from launching setup twice; the
# lock is held by the background job for its whole run, not by this returning hook.
if [ -n "${ALLOWLISTER_AUTO_SETUP:-}" ]; then
  mkdir -p .dev
  launcher="nohup"
  command -v setsid >/dev/null 2>&1 && launcher="setsid"
  "$launcher" bash -c 'exec 9>.dev/setup.lock; flock -n 9 || exit 0; exec bash scripts/setup.sh' \
    >.dev/setup.log 2>&1 </dev/null &
  printf '%s\n' \
    "[allowlister-remote] Dev environment not ready (${REASON}); provisioning in the BACKGROUND" \
    "(log: .dev/setup.log). It does not block this session. Verify with 'just setup-check'."
  exit 0
fi

# Default (local): advise. Do NOT block the session on a multi-minute install.
printf '%s\n' \
  "[allowlister-remote] Dev environment not set up yet (${REASON})." \
  "ACTION: run 'just setup' (or './scripts/setup.sh' if just is missing) as your FIRST step," \
  "before building or testing. It installs 'just', the JS + Rust dependencies (just bootstrap)," \
  "and the Playwright browsers (several minutes on a fresh machine)." \
  "Verify anytime with 'just setup-check'."
exit 0
