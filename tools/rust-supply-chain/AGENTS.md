# AGENTS — `tools/rust-supply-chain`

The Rust supply-chain gate (`type:tooling`): `cargo deny check` against the root
`deny.toml`, then `cargo machete`. Its own project so a policy edit selects only
this check, not every crate's tests.

- Every advisory ignore and duplicate-version skip in `deny.toml` carries its
  reason; remove an entry as soon as its cause is gone.
