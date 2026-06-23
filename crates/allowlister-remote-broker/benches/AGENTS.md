# AGENTS — benches

- Bench the broker's public, network-free protocol surface (`message_kind`, the
  parse, and the `added`/`resolved`/`decision`/`snapshot` envelope builders) so
  the numbers track the per-message work the broker runs between its two
  WebSocket edges, not internals that may be inlined away.
- Keep the network and shared state out of every measurement: no sockets, no
  heartbeat pings, no per-connection mpsc pumps, no routing mutex inside a timed
  loop. Those are IO and contention, covered by the broker's integration tests
  and the e2e suite, not here.
- Split parse from build: time the outbound envelope builders directly, and parse
  inbound frames in their own group, so serialization is never hidden behind
  parsing and vice versa.
- Shared fixtures (the inbound-frame corpus, request bodies, the pending-set
  generator) live in `support/` — a subdirectory so cargo's bench
  auto-discovery never treats the module as a target — and are pulled in via
  `#[path]`.
- `snapshot_message` is the one broker output whose size is unbounded; the
  `snapshot_scaling` group charts it over a growing pending set.
- `protocol_allocs` reports exact allocator tallies, not time: plain `main`, no
  Criterion, deterministic output for a given commit. Keep it that way — no
  timing, no randomness, no I/O inside a measured closure.
- `cargo check`/`clippy` cover these targets via `--all-targets`; keep them
  warning-clean so they cannot rot. `harness = false` keeps them out of the test
  runner and coverage.
