#!/usr/bin/env bash
# Measures allowlister-remote-pool-maintenance-seconds: one steady-state pass of
# the declared pool maintenance (`just pool-maintenance`, the recipe onevcs.toml
# names), after one ordinary run's worth of new superseded builds.
#
#   (a) run the declared maintenance once, untimed, to clear any backlog;
#   (b) build the gate's test targets under an alternative profile
#       (debug-assertions off), which gives every unit — this repository's
#       crates included — new metadata hashes, then backdate exactly the
#       entries that build created past the 2-day window;
#   (c) run the ordinary gate build, so each unit's newest build is the
#       ordinary one;
#   (d) time one declared pass, which removes the alternative builds.
#
# Only (d) is the figure: cargo-prune-superseded reports its own wall clock
# through the onebudgetspec SDK. The backlog pass's seconds are appended to the
# detail as separate evidence. The script fails if (d) removed nothing, removed
# anything (b) did not create, or left any ordinary entry missing.
#
# Entry listings (one path per line, named by metadata hash) are kept in
# $POOL_MAINTENANCE_WORK_DIR when it is set, else in a temporary directory.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

if [[ -n "${POOL_MAINTENANCE_WORK_DIR:-}" ]]; then
  work="$POOL_MAINTENANCE_WORK_DIR"
  mkdir -p "$work"
else
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
fi
result="${ONEBUDGETSPEC_RESULT:-$work/result.json}"

# Every build entry the pruner groups: the children of deps/, .fingerprint/,
# build/ and incremental/ in each profile directory under target/.
entries() {
  find target -type d -name .fingerprint -prune -print 2>/dev/null |
    while read -r fingerprint; do
      profile="$(dirname "$fingerprint")"
      for container in deps .fingerprint build incremental; do
        [[ -d "$profile/$container" ]] || continue
        find "$profile/$container" -mindepth 1 -maxdepth 1
      done
    done | LC_ALL=C sort
}

# The gate's test build: each workspace crate's `test` target runs
# `cargo llvm-cov --no-report -p <crate>`; `--list` builds the test binaries
# and lists their tests instead of running them.
mapfile -t crates < <(
  cargo metadata --no-deps --format-version 1 |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const p of JSON.parse(s).packages)console.log(p.name)})'
)
gate_build() {
  for crate in "${crates[@]}"; do
    cargo llvm-cov --no-report -p "$crate" -- --list >&2
  done
}

prune() {
  ONEBUDGETSPEC_RESULT="$1" just pool-maintenance >&2
}

echo "(a) untimed backlog pass" >&2
prune "$work/backlog.json"

echo "(b) alternative-configuration build, backdated past the window" >&2
entries >"$work/before-alt.txt"
CARGO_PROFILE_DEV_DEBUG_ASSERTIONS=false gate_build
entries >"$work/after-alt.txt"
LC_ALL=C comm -13 "$work/before-alt.txt" "$work/after-alt.txt" >"$work/alt.txt"
if [[ ! -s "$work/alt.txt" ]]; then
  echo "the alternative build created no entries; nothing stands in for a superseded run" >&2
  exit 1
fi
while read -r entry; do
  find "$entry" -exec touch -h -d '3 days ago' {} +
done <"$work/alt.txt"

echo "(c) ordinary gate build" >&2
gate_build
entries >"$work/before-timed.txt"
LC_ALL=C comm -23 "$work/before-timed.txt" "$work/alt.txt" >"$work/ordinary.txt"

echo "(d) timed pass" >&2
prune "$work/timed.json"
entries >"$work/after-timed.txt"
LC_ALL=C comm -23 "$work/before-timed.txt" "$work/after-timed.txt" >"$work/removed.txt"
LC_ALL=C comm -23 "$work/ordinary.txt" "$work/after-timed.txt" >"$work/ordinary-missing.txt"
LC_ALL=C comm -23 "$work/removed.txt" "$work/alt.txt" >"$work/removed-not-alt.txt"
if [[ ! -s "$work/removed.txt" ]]; then
  echo "the timed pass removed no entries" >&2
  exit 1
fi
if [[ -s "$work/ordinary-missing.txt" || -s "$work/removed-not-alt.txt" ]]; then
  echo "the timed pass removed entries the alternative build did not create:" >&2
  cat "$work/ordinary-missing.txt" "$work/removed-not-alt.txt" >&2
  exit 1
fi

node -e '
const fs = require("node:fs");
const [timedFile, backlogFile, out, alt, removed] = process.argv.slice(1);
const timed = JSON.parse(fs.readFileSync(timedFile, "utf8"));
const backlog = JSON.parse(fs.readFileSync(backlogFile, "utf8"));
const detail = `${timed.detail}; alternative entries created: ${alt}; entries removed: ${removed}; untimed backlog pass (not in the figure): ${backlog.value} seconds`;
fs.writeFileSync(out, JSON.stringify({ value: timed.value, detail }));
' "$work/timed.json" "$work/backlog.json" "$result" \
  "$(wc -l <"$work/alt.txt")" "$(wc -l <"$work/removed.txt")"
[[ -n "${ONEBUDGETSPEC_RESULT:-}" ]] || cat "$result"
