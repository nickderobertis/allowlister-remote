# AGENTS — `crates/allowlister-remote-e2e`

- `tests/full_chain.rs` spawns the built broker, daemon and plugin binaries (building any that
  are missing); never swap a hop for an in-process stub, or the chain it proves is gone. Keep it
  `type:test` so no project depends on it, with each binary an `implicitDependencies` edge so a
  change to any of them re-runs it.
