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

upgrade:
    npm update
    npm install
    @just check
