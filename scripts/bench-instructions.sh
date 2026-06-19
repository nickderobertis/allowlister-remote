#!/usr/bin/env bash
#
# Deterministic end-to-end CLI cost via instruction counts (valgrind's
# cachegrind, no cache simulation). Wall-clock timings (scripts/bench.sh) are
# noisy on shared hardware, so a small regression hides inside the jitter;
# instruction counts are reproducible to within ~0.1% (ASLR and environment
# size leave a little), which makes a base-vs-PR delta trustworthy where a
# hyperfine delta is not. Linux-only: it needs valgrind on PATH.
#
# Counts come from the `profiling` Cargo profile — codegen-matched to the
# shipped release profile, with symbols kept so a regression can be dug into
# with callgrind/cachegrind annotation tools afterwards.
#
# Like scripts/bench.sh, this covers the paths that resolve without a network
# round-trip (version, static defer, malformed input, unavailable server); the
# full remote approval round-trip is out of scope here and lives in the e2e
# suite.
#
# Usage:
#   scripts/bench-instructions.sh                   Run the suite.
#   scripts/bench-instructions.sh report BASE HEAD  Print a markdown delta table
#                                                   from two instructions.tsv files.
#
# Results: markdown table on stdout plus machine-readable exports under
# ${BENCH_OUT:-target/bench} (instructions.tsv, instructions.md).
#
# Environment overrides:
#   BENCH_OUT   output directory (default: <repo>/target/bench)

set -euo pipefail

fail() {
    printf 'FAIL: %s\n' "$*" >&2
    exit 1
}

# `report` joins a base and a head TSV (case<TAB>instructions) into a markdown
# delta table; it needs no valgrind, so CI can run it after checking back out
# of the base revision.
if [[ "${1:-}" == "report" ]]; then
    [[ $# -eq 3 && -s "$2" && -s "$3" ]] ||
        fail "usage: bench-instructions.sh report BASE.tsv HEAD.tsv (both non-empty)"
    awk -F'\t' '
        NR == FNR { base[$1] = $2; next }
        FNR == 1 {
            print "| command | base | head | Δ instructions |"
            print "|---|---:|---:|---:|"
        }
        {
            if ($1 in base && base[$1] > 0) {
                delta = ($2 - base[$1]) / base[$1] * 100
                printf "| %s | %s | %s | %+.2f%% |\n", $1, base[$1], $2, delta
            } else {
                printf "| %s | — | %s | new |\n", $1, $2
            }
        }
    ' "$2" "$3"
    exit 0
fi

[[ "${1:-}" == "" ]] || fail "usage: bench-instructions.sh [report BASE.tsv HEAD.tsv]"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bin="$repo_root/target/profiling/allowlister-remote-plugin"
out="${BENCH_OUT:-$repo_root/target/bench}"

note() { printf '%s\n' "$*"; }

command -v valgrind >/dev/null 2>&1 ||
    fail "valgrind not found on PATH (Linux-only; install it with your package manager, e.g. 'apt-get install valgrind')."

note "» building binary (profiling profile)"
(cd "$repo_root" && cargo build --profile profiling --locked --quiet -p allowlister-remote-plugin)
[ -x "$bin" ] || fail "profiling binary not found at $bin"

# Payload fixtures, mirroring scripts/bench.sh: a static allow verdict that
# defers without any network call, a defer verdict that opens a request, and a
# malformed body. Byte-identical on every run so the counts are reproducible.
sandbox="$(mktemp -d)"
cleanup() { rm -rf "$sandbox"; }
trap cleanup EXIT

allow="$sandbox/allow.json"
defer="$sandbox/defer.json"
malformed="$sandbox/malformed.json"
printf '{"current_verdict":"allow","command":"git status","cwd":"/tmp"}\n' >"$allow"
printf '{"current_verdict":"defer","command":"gh pr merge 42","cwd":"/tmp","harness":"codex"}\n' >"$defer"
printf 'not json\n' >"$malformed"

# An unreachable server URL (127.0.0.1:9, the discard port) refuses instantly,
# so the request-opening paths count stdin read + parse + triage + the failed
# create POST without blocking on a real decision.
dead="http://127.0.0.1:9"

mkdir -p "$out"
tsv="$out/instructions.tsv"
md="$out/instructions.md"
: >"$tsv"

# Run one case under cachegrind and append its instruction count to the TSV.
# The first argument names the case; the rest is the command. Callers wire any
# stdin redirect. Non-zero exits still produce a count, so they are tolerated.
measure() {
    local name="$1"
    shift
    local log="$sandbox/cachegrind.log"
    set +e
    valgrind --tool=cachegrind --cache-sim=no \
        --cachegrind-out-file="$sandbox/cachegrind.out" \
        --log-file="$log" -- "$@" >/dev/null
    set -e
    local refs
    refs="$(awk '/I +refs:/ { gsub(",", "", $4); print $4; exit }' "$log")"
    [ -n "$refs" ] || fail "no instruction count for '$name' (see $log)"
    printf '%s\t%s\n' "$name" "$refs" >>"$tsv"
    note "  $name: $refs instructions"
}

note "» counting instructions ($bin)"
measure "version" "$bin" --version
measure "defer:static" "$bin" --server-url "$dead" <"$allow"
measure "ask:malformed" "$bin" --server-url "$dead" <"$malformed"
measure "ask:unavailable" "$bin" --server-url "$dead" --timeout-ms 1 <"$defer"

{
    echo "| command | instructions |"
    echo "|---|---:|"
    awk -F'\t' '{ printf "| %s | %s |\n", $1, $2 }' "$tsv"
} >"$md"

note ""
note "✓ wrote $tsv"
note "       $md"
