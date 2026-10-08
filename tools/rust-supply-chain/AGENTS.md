# AGENTS — `tools/rust-supply-chain`

- `tools/rust-supply-chain` (`type:tooling`) holds the `supply-chain` gate:
  `cargo deny check` against the root `deny.toml`, then `cargo machete`. It is its
  own project so a policy edit never re-runs every crate's tests.
- Every advisory ignore and duplicate-version skip in `deny.toml` carries its
  reason; remove an entry as soon as its cause is gone.
