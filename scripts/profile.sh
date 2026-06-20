#!/usr/bin/env bash
#
# Sampling profiler for the allowlister-remote plugin, built on samply (records
# a trace you open in the Firefox Profiler UI).
#
# Both sampling modes build the dedicated `profiling` profile (workspace
# Cargo.toml): the shipped release optimizations, but with symbols kept so
# samply can attribute time to functions. The real `[profile.release]` artifact
# stays stripped.
#
# Usage:
#   scripts/profile.sh                    Profile the engine hot path (Criterion).
#   scripts/profile.sh engine [FILTER]    Profile one or more Criterion benches
#                                         (e.g. triage/pipeline).
#   scripts/profile.sh cli                Profile the no-network defer fast path
#                                         (startup + stdin parse + triage), looped
#                                         so the sub-millisecond process yields
#                                         enough samples.
#   scripts/profile.sh callgrind          Deterministic per-function attribution
#                                         of one CLI invocation (valgrind; Linux).
#
# A single CLI run is far too short to sample, which is why the engine mode
# (Criterion's `--profile-time`, a long-running in-process loop) is the right
# tool for the pure functions, and the CLI mode loops the binary.
#
# samply needs perf-event access the kernel often withholds in containers and
# CI. The callgrind mode is the fallback that works anywhere valgrind does: it
# runs ONE invocation (no looping — counts are exact, not sampled), writes the
# raw callgrind output under target/profile/, and prints the top functions by
# instruction count.
#
# Environment overrides:
#   PROFILE_SECONDS   engine mode: seconds to sample (default: 10)
#   PROFILE_REPEAT    cli mode: invocations to loop under the profiler (default: 5000)
#   PROFILE_TOP       callgrind mode: function rows to print (default: 30)
#   SAMPLY_ARGS       extra args passed to `samply record` (e.g. --save-only)

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
seconds="${PROFILE_SECONDS:-10}"
repeat="${PROFILE_REPEAT:-5000}"
# shellcheck disable=SC2206  # intentional word-splitting of optional flags.
samply_args=(${SAMPLY_ARGS:-})

fail() {
    printf 'FAIL: %s\n' "$*" >&2
    exit 1
}

# A static allow payload exercises the no-network fast path: stdin read + JSON
# parse + triage + defer response, with no socket to a server.
write_payload() {
    printf '{"current_verdict":"allow","command":"git status","project":"/tmp"}\n' >"$1"
}

mode="${1:-engine}"

# Deterministic per-function attribution of a single CLI invocation. No samply
# (and no perf-event access) needed, so it works in containers and CI.
if [[ "$mode" == "callgrind" ]]; then
    command -v valgrind >/dev/null 2>&1 ||
        fail "valgrind not found on PATH (Linux-only; install it with your package manager)."
    command -v callgrind_annotate >/dev/null 2>&1 ||
        fail "callgrind_annotate not found on PATH (ships with valgrind)."
    bin="$repo_root/target/profiling/allowlister-remote-plugin"
    echo "» building binary (profiling profile)"
    (cd "$repo_root" && cargo build --profile profiling --locked --quiet -p allowlister-remote-plugin)
    [ -x "$bin" ] || fail "profiling binary not found at $bin"
    outdir="$repo_root/target/profile"
    mkdir -p "$outdir"
    payload="$outdir/payload.json"
    write_payload "$payload"
    out="$outdir/callgrind.out"
    echo "» running '$bin' under callgrind (defer fast path)"
    valgrind --tool=callgrind --callgrind-out-file="$out" -- \
        "$bin" --server-url http://127.0.0.1:9 <"$payload" >/dev/null || true
    echo
    echo "» top ${PROFILE_TOP:-30} functions by instruction count (full data: $out)"
    callgrind_annotate --threshold=99 "$out" | head -n "$((${PROFILE_TOP:-30} + 12))"
    exit 0
fi

command -v samply >/dev/null 2>&1 ||
    fail "samply not found on PATH. Install it with 'cargo install --locked samply'."

if [[ "$mode" == "engine" ]]; then
    shift || true
    filter="${1:-}"
    echo "» building bench (profiling profile)"
    # Build the bench with symbols, then read its executable path from cargo's
    # JSON output (no jq dependency).
    artifact="$(cargo build --profile profiling --bench engine --locked --message-format=json -q |
        grep -F '"name":"engine"' | grep -F '"executable":' | tail -1)"
    bench_exe="$(printf '%s' "$artifact" | grep -o '"executable":"[^"]*"' | cut -d'"' -f4)"
    [ -n "$bench_exe" ] && [ -x "$bench_exe" ] || fail "could not locate the profiling bench executable"
    echo "» profiling engine for ${seconds}s (${filter:-all benchmarks})"
    # `--profile-time` makes Criterion run the bench in a plain loop with no
    # statistical analysis — exactly what an external sampler wants.
    samply record "${samply_args[@]}" -- \
        "$bench_exe" --bench --profile-time "$seconds" ${filter:+"$filter"}
    exit 0
fi

if [[ "$mode" != "cli" ]]; then
    fail "usage: profile.sh [engine [FILTER] | cli | callgrind]"
fi

# CLI mode: profile a real invocation, looped so a sub-millisecond process is
# sampled enough times to be meaningful (covers startup + stdin parse + triage).
bin="$repo_root/target/profiling/allowlister-remote-plugin"
echo "» building binary (profiling profile)"
(cd "$repo_root" && cargo build --profile profiling --locked --quiet -p allowlister-remote-plugin)
[ -x "$bin" ] || fail "profiling binary not found at $bin"
payload="$repo_root/target/profiling/payload.json"
write_payload "$payload"
echo "» profiling '$bin' (defer fast path) over $repeat invocations"
samply record "${samply_args[@]}" -- \
    bash -c 'n="$1"; bin="$2"; payload="$3"; for ((i = 0; i < n; i++)); do "$bin" --server-url http://127.0.0.1:9 <"$payload" >/dev/null 2>&1 || true; done' \
    _ "$repeat" "$bin" "$payload"
