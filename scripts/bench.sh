#!/usr/bin/env bash
#
# End-to-end CLI latency benchmark for the allowlister-remote plugin. Drives the
# optimized release binary the way an agent harness does — one process per
# invocation, payload on stdin — and measures wall-clock time with hyperfine.
#
# This captures the cost that matters in production for the paths that resolve
# without a network round-trip: process startup + stdin read + JSON parse +
# triage + response serialization. The full remote approval round-trip (HTTP
# create + poll) is intentionally out of scope here — it needs a live server and
# a human decision, and is covered end to end by the Playwright e2e suite. The
# in-process Criterion benches (`benches/engine.rs`) isolate the same pure
# functions without process startup.
#
# Usage:
#   scripts/bench.sh            Full run (warmup + adaptive sampling).
#   scripts/bench.sh --dry-run  One run, no warmup — a fast smoke check that the
#                               harness and every command still work (used by CI
#                               and `just`), without depending on stable numbers.
#
# Results: human table on stdout plus machine-readable exports under
# ${BENCH_OUT:-target/bench} (results.json, results.md).
#
# Environment overrides:
#   BENCH_OUT     output directory (default: <repo>/target/bench)
#   BENCH_WARMUP  warmup runs before timing (default: 10)

set -euo pipefail

mode="${1:-run}"
case "$mode" in
    run | --dry-run) ;;
    *)
        echo "usage: bench.sh [--dry-run]" >&2
        exit 2
        ;;
esac

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bin="$repo_root/target/release/allowlister-remote-plugin"
out="${BENCH_OUT:-$repo_root/target/bench}"
warmup="${BENCH_WARMUP:-10}"

note() { printf '%s\n' "$*"; }
fail() {
    printf 'FAIL: %s\n' "$*" >&2
    exit 1
}

if ! command -v hyperfine >/dev/null 2>&1; then
    fail "hyperfine not found on PATH. Install it with 'cargo install --locked hyperfine' (or your package manager)."
fi

# A `--dry-run` proves the harness and commands work without spending time on
# statistics; the full run warms up and lets hyperfine sample adaptively.
runs_opt=()
if [[ "$mode" == "--dry-run" ]]; then
    warmup=0
    runs_opt=(--runs 1)
fi

note "» building release binary"
(cd "$repo_root" && cargo build --release --locked --quiet -p allowlister-remote-plugin)
[ -x "$bin" ] || fail "release binary not found at $bin"

# Payload fixtures in a temp sandbox: a static allow verdict that defers without
# any network call, a defer verdict that would open a request, and a malformed
# body that falls back to `ask`.
sandbox="$(mktemp -d)"
cleanup() { rm -rf "$sandbox"; }
trap cleanup EXIT

allow="$sandbox/allow.json"
defer="$sandbox/defer.json"
malformed="$sandbox/malformed.json"
printf '{"current_verdict":"allow","command":"git status","cwd":"/tmp"}\n' >"$allow"
printf '{"current_verdict":"defer","command":"gh pr merge 42","cwd":"/tmp","harness":"codex"}\n' >"$defer"
printf 'not json\n' >"$malformed"

# An unreachable server URL — 127.0.0.1:9 (the discard port) refuses instantly —
# so the request-opening path measures stdin read + parse + triage + the create
# POST attempt without blocking on a real decision.
dead="http://127.0.0.1:9"

mkdir -p "$out"

note "» benchmarking $bin"
# `version` is pure startup; `defer:static` short-circuits before any socket;
# `ask:malformed` rejects bad input before any socket; `ask:unavailable` adds the
# failed create POST against the dead port. All exit 0, so hyperfine needs no
# `|| true`.
hyperfine \
    --warmup "$warmup" "${runs_opt[@]}" \
    --export-json "$out/results.json" \
    --export-markdown "$out/results.md" \
    -n "version" "'$bin' --version" \
    -n "defer:static" "'$bin' --server-url '$dead' < '$allow'" \
    -n "ask:malformed" "'$bin' --server-url '$dead' < '$malformed'" \
    -n "ask:unavailable" "'$bin' --server-url '$dead' --timeout-ms 1 < '$defer'"

note ""
note "✓ wrote $out/results.json"
note "       $out/results.md"
