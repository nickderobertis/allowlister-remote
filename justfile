set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

default:
    @just --list

bootstrap:
    npm ci

check: fmt-check lint typecheck test build test-e2e
    @echo "check: ok"

fmt-check:
    npx prettier --check .

format:
    npx prettier --write .

lint:
    npm run lint

typecheck:
    npm run typecheck

test:
    npm test -- --run

build:
    npm run build

test-e2e:
    npm run test:e2e

dev:
    npm run dev

upgrade:
    npm update
    npm install
    @just check
