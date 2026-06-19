# AGENTS — benches

- Bench the plugin's public, network-free surface (`triage`, `build_create_body`,
  `interpret_decision`, `parse_local_input`) so the numbers track what the binary
  runs between stdin and the network, not internals that may be inlined away.
- Keep the network out of every measurement: no HTTP, no sockets, no terminal
  I/O inside a timed loop. Process startup and the remote round-trip are covered
  by `scripts/bench.sh` (hyperfine) and the e2e suite, not here.
- Split parse from build: time `build_create_body` over a pre-parsed `Value` so
  body construction is not hidden behind JSON parsing.
- Shared fixtures (the payload corpus, decision bodies, terminal inputs) live in
  `support/` — a subdirectory so cargo's bench auto-discovery never treats the
  module as a target — and are pulled in via `#[path]`.
- The corpus is the realistic floor; the `triage_scaling` group uses `&&` chains
  of growing length to chart how parse + build cost grows with command size.
- `engine_allocs` reports exact allocator tallies, not time: plain `main`, no
  Criterion, deterministic output for a given commit. Keep it that way — no
  timing, no randomness, no I/O inside a measured closure.
- `cargo check`/`clippy` cover these targets via `--all-targets`; keep them
  warning-clean so they cannot rot. `harness = false` keeps them out of the test
  runner and coverage.
