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

check: test
    if [[ -n "${NX_BASE:-}" ]]; then npx nx affected -t fmt-check lint lint-compiler typecheck build test-e2e --base "$NX_BASE" --head "${NX_HEAD:-HEAD}"; else npx nx affected -t fmt-check lint lint-compiler typecheck build test-e2e --uncommitted; fi
    @echo "check: ok"

fmt-check:
    if [[ -n "${NX_BASE:-}" ]]; then npx nx affected -t fmt-check --base "$NX_BASE" --head "${NX_HEAD:-HEAD}"; else npx nx affected -t fmt-check --uncommitted; fi

format:
    if [[ -n "${NX_BASE:-}" ]]; then npx nx affected -t format --base "$NX_BASE" --head "${NX_HEAD:-HEAD}"; else npx nx affected -t format --uncommitted; fi

lint:
    if [[ -n "${NX_BASE:-}" ]]; then npx nx affected -t lint --base "$NX_BASE" --head "${NX_HEAD:-HEAD}"; else npx nx affected -t lint --uncommitted; fi

typecheck:
    if [[ -n "${NX_BASE:-}" ]]; then npx nx affected -t typecheck --base "$NX_BASE" --head "${NX_HEAD:-HEAD}"; else npx nx affected -t typecheck --uncommitted; fi

test:
    if [[ -n "${NX_BASE:-}" ]]; then npx nx affected -t test --base "$NX_BASE" --head "${NX_HEAD:-HEAD}"; else npx nx affected -t test --uncommitted; fi

build:
    if [[ -n "${NX_BASE:-}" ]]; then npx nx affected -t build --base "$NX_BASE" --head "${NX_HEAD:-HEAD}"; else npx nx affected -t build --uncommitted; fi

test-e2e:
    if [[ -n "${NX_BASE:-}" ]]; then npx nx affected -t test-e2e --base "$NX_BASE" --head "${NX_HEAD:-HEAD}"; else npx nx affected -t test-e2e --uncommitted; fi

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

upgrade:
    npm update
    npm install
    @just check

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
