# AGENTS — benches

- Bench the daemon's public, network-free protocol surface (`build_create_msg`,
  `decision_target`, `local_decision`) so the numbers track the per-message work
  the daemon runs between the IPC socket and the broker connection, not internals
  that may be inlined away.
- Keep the network and shared state out of every measurement: no sockets, no TLS,
  no routing-table mutex, no reconnect supervision inside a timed loop. Those are
  IO and contention, covered by the daemon's integration tests and the e2e suite,
  not here.
- Split parse from build: time `build_create_msg` over a pre-parsed `Value` so the
  envelope re-serialization is not hidden behind JSON parsing (a separate
  `parse_create` group charts the parse cost).
- Shared fixtures (the create-message corpus, inbound frames, terminal lines)
  live in `support/` — a subdirectory so cargo's bench auto-discovery never treats
  the module as a target — and are pulled in via `#[path]`. The corpus mirrors the
  plugin bench corpus so the two ends of the IPC channel are charted over the same
  request shapes.
- `protocol_allocs` reports exact allocator tallies, not time: plain `main`, no
  Criterion, deterministic output for a given commit. Keep it that way — no
  timing, no randomness, no I/O inside a measured closure. Use the fixed
  `REQUEST_ID`, never the real `new_request_id` (it reads the wall clock).
- `cargo check`/`clippy` cover these targets via `--all-targets`; keep them
  warning-clean so they cannot rot. `harness = false` keeps them out of the test
  runner and coverage.
