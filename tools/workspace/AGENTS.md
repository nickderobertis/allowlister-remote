# AGENTS — `tools/workspace`

Repo-level checks that belong to no single deliverable (`type:tooling`). Root
guidance lives in the repo `AGENTS.md`.

- `lint` — Biome over this directory, then `check-boundaries.mjs`: the tag-based
  module-boundary rules over the Nx graph (no project depends on a `type:e2e` or
  `type:test` project; a `type:contract` project depends only on contracts) and a
  cross-check that every Cargo path dependency between crates is a declared Nx
  edge (Nx does not infer Rust dependencies here; crates declare
  `implicitDependencies`).
- `test` — `node --test` over `tests/`: the CI workflow contract (fixed status
  contexts, release-PR sweep routing, least privilege, fail-fast llmlint), the
  boundary checker, affected selection and task ordering asked of `nx` itself, and
  the SessionStart / pre-push hooks run in scratch copies. Tests list their files
  explicitly in `project.json` because CI's Node 20 does not take a directory.
- `coverage` — the Rust aggregate: depends on every crate's `test` (each runs
  `cargo llvm-cov --no-report`, after `coverage-clean` drops stale profiles) and
  enforces `cargo llvm-cov report --fail-under-lines 78` over the union (the floor
  and its reason are in the root `AGENTS.md`).
- `supply-chain` — `cargo deny check` (policy in the root `deny.toml`) and
  `cargo machete`.

Inputs are explicit so this project is selected exactly when a file it reads
changes: workflows, the justfile, the hooks and llmlint setup scripts, every
`project.json`, crate manifests, `deny.toml`, and (for `coverage`) every crate
source. Scripts here use Node built-ins plus the `yaml` dev dependency only.
