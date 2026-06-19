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
    if [[ -n "${NX_BASE:-}" ]]; then npx nx affected -t fmt-check lint typecheck build test-e2e --base "$NX_BASE" --head "${NX_HEAD:-HEAD}"; else npx nx affected -t fmt-check lint typecheck build test-e2e --uncommitted; fi
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
capture:
    npx nx run web:capture

upgrade:
    npm update
    npm install
    @just check

# Performance suite (informational — measured, not gated). See
# crates/allowlister-remote-plugin/benches/ and scripts/{bench,profile}.sh.

# Criterion micro-benchmarks of the pure decision path; saves a "current" baseline.
bench:
    cargo bench --locked -p allowlister-remote-plugin --bench engine -- --save-baseline current

# Save a "base" baseline to diff against later with `just bench-compare`.
bench-base:
    cargo bench --locked -p allowlister-remote-plugin --bench engine -- --save-baseline base

# Diff the saved baselines (needs critcmp: `cargo install --locked critcmp`).
bench-compare:
    critcmp base current

# Deterministic allocator tallies for the same hot paths (markdown table).
bench-allocs:
    cargo bench --locked --quiet -p allowlister-remote-plugin --bench engine_allocs

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
