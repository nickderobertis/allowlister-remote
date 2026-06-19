#!/usr/bin/env bash
# Report whether the dev environment is ready (used by `just setup-check` and as
# a quick manual probe). Exit 0 when ready, 1 otherwise.
set -eu

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/setup-lib.sh
. scripts/setup-lib.sh
_load_tool_env

if _check_ready; then
  printf '✓ dev environment ready\n'
  exit 0
fi

printf '✗ dev environment not ready: %s\n' "${REASON}"
printf '  run `just setup` (or `./scripts/setup.sh` if just is missing) to provision.\n'
exit 1
