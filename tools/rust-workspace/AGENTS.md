# AGENTS — `tools/rust-workspace`

The workspace-wide Rust coverage gate (`type:tooling`).

- `coverage` depends on every crate's `test` (each runs `cargo llvm-cov
  --no-report` after `coverage-clean` removes the workspace's previous
  instrumented builds and profiles) and enforces the floor over their union. Never
  cache these targets or skip the clean: stale objects or a partial profile set
  report a wrong number.
- The floor is `--fail-under-lines 78`, below the create-repo 95% default by
  manager approval; measured at 79.53% lines over every crate's tests (cargo-llvm-cov
  0.8.7). It is low because the broker and daemon binaries run only under tests
  that SIGKILL them, so their profiles never flush, and the plugin's `/dev/tty` and
  named-pipe paths have no test. Raising it to 95% (graceful shutdown so profiles
  flush, plus those tests) is an open follow-up; never lower it.
- `tools/rust-workspace` holds the Rust `coverage` aggregate, its own project so a
  workflow or hook edit never re-runs every crate's tests.
