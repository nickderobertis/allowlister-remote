# AGENTS — `crates/allowlister-remote-daemon`

- `crates/allowlister-remote-daemon` is the per-host daemon: one long-lived process that
  multiplexes the host's ephemeral plugin processes onto a single supervised WebSocket to the
  broker, re-announcing still-pending requests on reconnect. Plugin↔daemon is a Unix socket on
  Unix and a named pipe on Windows (a transport-generic `handle_plugin` serves both).
- Performance is informational: `just bench-daemon` (Criterion, `benches/protocol.rs`) and
  `just bench-allocs-daemon` (allocation tallies, `benches/protocol_allocs.rs`) cover the
  protocol surface (`build_create_msg`, `decision_target`, `local_decision`), the per-message work between the IPC socket and the broker connection; `just profile-daemon` samples the
  Criterion bench via `PROFILE_PKG`/`PROFILE_BENCH` in `scripts/profile.sh`.
