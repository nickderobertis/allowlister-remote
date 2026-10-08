# AGENTS — `tools/rust-workspace`

The workspace-wide Rust coverage gate (`type:tooling`), kept apart from
`tools/workspace` and the supply-chain check so only a Rust change re-runs every
crate's tests.

- `coverage` depends on every crate's `test` (each runs `cargo llvm-cov
  --no-report` after `coverage-clean` removes the workspace's previous
  instrumented builds and profiles) and enforces the floor over their union. Never
  cache these targets or skip the clean: stale objects or a partial profile set
  report a wrong number.
- `tools/rust-workspace` holds the Rust `coverage` aggregate and
  `tools/rust-supply-chain` the `supply-chain` gate, each its own project so a workflow, hook or
  policy edit never re-runs every crate's tests.
