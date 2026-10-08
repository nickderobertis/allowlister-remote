set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

default:
    @just --list

bootstrap:
    npm ci
    cargo fetch

setup:
    @bash scripts/setup.sh

setup-check:
    @bash scripts/setup-check.sh

# The merge base the affected tier keys off. CI exports NX_BASE/NX_HEAD (derived
# explicitly in check.yml); locally NX_BASE defaults to origin/main, and nx
# affected compares against the merge base of that ref and HEAD — so a committed
# branch checks what its commits changed (plus any uncommitted work when NX_HEAD
# is unset), never an uncommitted-only set. Validate that environment input before
# anything interpolates it: a git ref or SHA is letters, digits and `. _ / -`.
_nx_base_input := env_var_or_default("NX_BASE", "origin/main")
_nx_head_input := env_var_or_default("NX_HEAD", "")
base := if _nx_base_input =~ '^[A-Za-z0-9._/-]+$' { _nx_base_input } else { error("NX_BASE must be a plain git ref or SHA — letters, digits and . _ / - only; got: " + _nx_base_input) }
_head_flag := if _nx_head_input == "" { "" } else if _nx_head_input =~ '^[A-Za-z0-9._/-]+$' { " --head=" + _nx_head_input } else { error("NX_HEAD must be a plain git ref or SHA — letters, digits and . _ / - only; got: " + _nx_head_input) }
_affected := "npx nx affected --base=" + base + _head_flag

# Full quality gate. Defaults to the AFFECTED tier (every target this change can
# reach, against the merge base above); `just check all` runs the BROADER tier,
# one sweep over every project. This repo batches releases behind
# release-please's release PR, so CI runs the sweep on that PR (check.yml) and the
# affected tier everywhere else. The tier is a flag on this one recipe, never a
# second gate; a mistyped tier aborts instead of quietly buying the weaker one.
check tier="affected":
    @just test {{ if tier == "all" { "all" } else if tier == "affected" { "affected" } else { error("unknown tier '" + tier + "' — use 'affected' (the default) or 'all'") } }}
    {{ if tier == "all" { "npx nx run-many" } else if tier == "affected" { _affected } else { error("unknown tier '" + tier + "' — use 'affected' (the default) or 'all'") } }} -t fmt-check lint lint-compiler typecheck build supply-chain test-e2e
    @echo "check: ok"

fmt-check:
    {{ _affected }} -t fmt-check

format:
    {{ _affected }} -t format

lint:
    {{ _affected }} -t lint

typecheck:
    {{ _affected }} -t typecheck

# Unit/integration tests plus the repo-level Rust coverage aggregate (the crates'
# `test` targets write raw profiles; `coverage` merges and enforces the floor).
test tier="affected":
    {{ if tier == "all" { "npx nx run-many" } else if tier == "affected" { _affected } else { error("unknown tier '" + tier + "' — use 'affected' (the default) or 'all'") } }} -t test coverage

build:
    {{ _affected }} -t build

# The browser e2e suite (web-e2e); `just test-e2e all` runs it whatever changed.
# (The Rust e2e crate is a `test` target, run by `just test`.)
test-e2e tier="affected":
    {{ if tier == "all" { "npx nx run-many" } else if tier == "affected" { _affected } else { error("unknown tier '" + tier + "' — use 'affected' (the default) or 'all'") } }} -t test-e2e

# One filtered browser e2e run, after the same builds: the args go to Playwright,
# e.g. `just test-e2e-web notifications.spec.ts --project chromium-desktop`.
[positional-arguments]
test-e2e-web *args:
    npx nx run web-e2e:test-e2e -- "$@"

dev:
    npx nx run web:dev

smoke-e2e version="":
    npx nx run web:build
    npm run release:smoke-e2e -- "{{version}}"

# Capture deterministic screenshots into shots/current/<arch>/ (captures.json +
# the PNGs it references) for screencomp's visual-docs gate (builds the app first).
# This also emits the terminal-prompt SVG shots (apps/web/screenshots/terminal.capture.ts).
capture:
    npx nx run web:capture

# Re-record the local-terminal approval prompt fixture from the real plugin
# binary (apps/web/screenshots/terminal/prompts.json). Run after changing the
# prompt wording in the plugin; tests/terminal_prompt.rs guards it from drifting.
record-terminal-prompts:
    cargo build -p allowlister-remote-plugin --bin allowlister-remote-plugin
    python3 scripts/record-terminal-prompts.py

# Upgrade every ecosystem's dependencies, then re-run the gate as the full sweep:
# an upgrade can reach any project, so the affected set would understate it.
upgrade:
    npm update
    npm install
    cargo update
    @just check all

# Performance suite (informational — measured, not gated). Each Rust binary has
# the same two layers over its pure, network-free surface: Criterion timings and
# deterministic allocation tallies. The plugin (a one-shot CLI) additionally has
# end-to-end CLI latency/instruction layers below; the daemon and broker are
# long-lived servers, so per-process startup is amortized and those CLI layers do
# not apply — their hot path is the per-message protocol work. See each crate's
# benches/ and scripts/{bench,profile}.sh.

# Criterion micro-benchmarks of the plugin's pure decision path; saves a "current" baseline.
bench:
    cargo bench --locked -p allowlister-remote-plugin --bench engine -- --save-baseline current

# Criterion micro-benchmarks of the daemon's pure protocol path.
bench-daemon:
    cargo bench --locked -p allowlister-remote-daemon --bench protocol

# Criterion micro-benchmarks of the broker's pure protocol path.
bench-broker:
    cargo bench --locked -p allowlister-remote-broker --bench protocol

# Save a "base" baseline to diff against later with `just bench-compare`.
bench-base:
    cargo bench --locked -p allowlister-remote-plugin --bench engine -- --save-baseline base

# Diff the saved baselines (needs critcmp: `cargo install --locked critcmp`).
bench-compare:
    critcmp base current

# Deterministic allocator tallies for the plugin's hot paths (markdown table).
bench-allocs:
    cargo bench --locked --quiet -p allowlister-remote-plugin --bench engine_allocs

# Deterministic allocator tallies for the daemon's protocol path (markdown table).
bench-allocs-daemon:
    cargo bench --locked --quiet -p allowlister-remote-daemon --bench protocol_allocs

# Deterministic allocator tallies for the broker's protocol path (markdown table).
bench-allocs-broker:
    cargo bench --locked --quiet -p allowlister-remote-broker --bench protocol_allocs

# Deterministic end-to-end CLI instruction counts (valgrind cachegrind).
bench-instructions:
    @bash scripts/bench-instructions.sh

# End-to-end CLI latency with hyperfine (no-network fast paths).
bench-cli:
    @bash scripts/bench.sh

# Fast smoke check that the CLI bench harness still works (one run, no warmup).
bench-cli-smoke:
    @bash scripts/bench.sh --dry-run

# Sampling/instruction profiler (samply or callgrind). E.g. `just profile cli`.
profile *args:
    @bash scripts/profile.sh {{args}}

# Sample the daemon's protocol bench hot path (samply). Optional Criterion filter.
profile-daemon *args:
    @PROFILE_PKG=allowlister-remote-daemon PROFILE_BENCH=protocol bash scripts/profile.sh engine {{args}}

# Sample the broker's protocol bench hot path (samply). Optional Criterion filter.
profile-broker *args:
    @PROFILE_PKG=allowlister-remote-broker PROFILE_BENCH=protocol bash scripts/profile.sh engine {{args}}

# Web PWA performance suite (informational — measured, not gated). Mirrors the
# plugin suite above: Vitest micro-benchmarks of the pure decision surface, a
# deterministic client bundle-size report, and a Lighthouse runtime audit. The
# `Performance` workflow (bench.yml) runs these on every PR and posts the numbers
# as a sticky comment plus a job summary.

# Vitest micro-benchmarks of the pure decision/summarization functions.
bench-web:
    npx nx run web:bench

# Deterministic client bundle-size report (gzip + raw). Builds the app first.
bundle-size:
    npx nx run web:build
    node scripts/web-bundle-size.mjs

# Deterministic render-cost report: decision-surface recomputations per
# interaction, without React Compiler vs with it. Runs the harness both ways.
render-cost:
    npx nx run web:render-cost

# Deterministic heap-footprint report: retained memory per inbox card plus an
# inbox retention/leak check. The web analogue of `just bench-allocs`.
heap:
    npx nx run web:heap

# Lighthouse runtime audit of the built PWA (needs Chrome on PATH or CHROME_PATH).
lighthouse:
    npx nx run web:build
    node scripts/web-lighthouse.mjs

# Install/refresh the llmlint toolchain (oneharness + llmlint). Idempotent. The
# SessionStart hook (scripts/session-setup.sh) hands off to it automatically; this
# is the manual entry point for a plain terminal.
setup-llmlint:
    bash scripts/setup-llmlint.sh

# LLM-judge lint (llmlint) over the configured set, or the paths passed. Kept out
# of `check`: it is non-deterministic and needs an authenticated harness.
[positional-arguments]
lint-llm *paths:
    @command -v llmlint >/dev/null 2>&1 || { echo "llmlint not installed — run 'just setup-llmlint'"; exit 1; }
    llmlint "$@"

# llmlint scoped to the lines this branch changed since it forked from BASE
# (three-dot/merge-base semantics). This is the blocking `llmlint` PR check.
[positional-arguments]
lint-llm-diff base="origin/main" *args:
    @command -v llmlint >/dev/null 2>&1 || { echo "llmlint not installed — run 'just setup-llmlint'"; exit 1; }
    @[[ "$1" =~ ^[A-Za-z0-9._/-]+$ ]] || { echo "base must be a plain git ref or SHA; got: $1" >&2; exit 2; }
    llmlint --diff --diff-base "$1" "${@:2}"

# Deterministic llmlint gate — no model call, no credential: config structure,
# `llmlint: ignore` directives name real rules, edited versioned fragments bumped
# their `version:`. CI runs it with `--diff-base origin/main` before the model step.
[positional-arguments]
lint-llm-validate *args:
    @command -v llmlint >/dev/null 2>&1 || { echo "llmlint not installed — run 'just setup-llmlint'"; exit 1; }
    llmlint validate "$@"
