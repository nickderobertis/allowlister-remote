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
# Measure the artifact that actually ships: the linux binary is a static musl
# build (see .github/workflows/publish.yml), whose startup cost differs sharply
# from a glibc dev build (no dynamic loader). Override BENCH_TARGET to count a
# different triple, e.g. the host glibc build.
target="${BENCH_TARGET:-x86_64-unknown-linux-musl}"
bin="$repo_root/target/$target/profiling/allowlister-remote-plugin"
out="${BENCH_OUT:-$repo_root/target/bench}"

note() { printf '%s\n' "$*"; }

command -v valgrind >/dev/null 2>&1 ||
    fail "valgrind not found on PATH (Linux-only; install it with your package manager, e.g. 'apt-get install valgrind')."

note "» building binary (profiling profile, $target)"
if [[ "$target" == *musl* ]] && ! command -v musl-gcc >/dev/null 2>&1; then
    fail "musl-gcc not found, needed to build the $target binary (install 'musl-tools'). Set BENCH_TARGET to a non-musl triple to count a glibc build instead."
fi
# CC_<target> points ring's C build at musl-gcc when cross-building musl; the
# var is musl-specific, so exporting it is harmless for other triples.
(cd "$repo_root" && CC_x86_64_unknown_linux_musl="${CC_x86_64_unknown_linux_musl:-musl-gcc}" \
    cargo build --profile profiling --locked --quiet --target "$target" -p allowlister-remote-plugin)
[ -x "$bin" ] || fail "profiling binary not found at $bin"

# Payload fixtures, mirroring scripts/bench.sh: a static allow verdict that
# defers without touching the daemon, and a malformed body. Byte-identical on
# every run so the counts are reproducible. The needs-approval path is not
# counted here — it hands off to the daemon and waits for a human.
sandbox="$(mktemp -d)"
cleanup() { rm -rf "$sandbox"; }
trap cleanup EXIT

allow="$sandbox/allow.json"
malformed="$sandbox/malformed.json"
printf '{"current_verdict":"allow","command":"git status","cwd":"/tmp"}\n' >"$allow"
printf 'not json\n' >"$malformed"

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
measure "defer:static" "$bin" <"$allow"
measure "ask:malformed" "$bin" <"$malformed"

{
    echo "| command | instructions |"
    echo "|---|---:|"
    awk -F'\t' '{ printf "| %s | %s |\n", $1, $2 }' "$tsv"
} >"$md"

note ""
note "✓ wrote $tsv"
note "       $md"
