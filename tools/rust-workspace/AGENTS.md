# AGENTS — `tools/rust-workspace`

The workspace-wide Rust checks (`type:tooling`), kept apart from `tools/workspace`
so a workflow or hook edit never re-runs every crate's tests.

- `coverage` depends on every crate's `test` (each runs `cargo llvm-cov
  --no-report` after `coverage-clean` removes the workspace's previous
  instrumented builds and profiles) and enforces the floor over their union. Never
  cache these targets or skip the clean: stale objects or a partial profile set
  report a wrong number.
- `supply-chain` runs `cargo deny check` against the root `deny.toml`, then
  `cargo machete`. Every advisory ignore and duplicate-version skip there carries
  its reason; remove an entry as soon as its cause is gone.
