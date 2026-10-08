# AGENTS — `crates/allowlister-remote-daemon`

- `crates/allowlister-remote-daemon` is the per-host daemon: one long-lived process that
  multiplexes the host's ephemeral plugin processes onto a single supervised WebSocket to the
  broker, re-announcing still-pending requests on reconnect. Plugin↔daemon is a Unix socket on
  Unix and a named pipe on Windows (a transport-generic `handle_plugin` serves both).
