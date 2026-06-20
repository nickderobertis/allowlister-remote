# Realtime-sync prototypes

Small, self-contained programs that validate the riskiest mechanics in
[`../realtime-sync.md`](../realtime-sync.md) before any production code is
written. They are **throwaway validation harnesses**, not shippable code: no
external dependencies, not wired into Nx/CI, and each asserts its own claims and
exits non-zero on failure.

## `broker-proto.mjs` — server-side transport mechanics

Plain Node (`http`, `events`) — no Next.js, because the transport mechanics are
runtime-agnostic. Models the in-memory store as `maps + EventEmitter + replayable
event log`, then drives a server through the full flow.

```
node broker-proto.mjs          # run server + self-test, exits 0 on pass
node broker-proto.mjs serve    # run just the server (PORT, default 8787) to poke by hand
```

Proves: long-poll hangs while pending and releases in ~one RTT on a decision;
SSE pushes the `decided` event; a reconnecting client replays missed events via
`Last-Event-ID`; heartbeats are emitted.

## `daemon-proto.rs` — client-side multiplexing

std-only Rust (real Unix-domain socket), so it compiles standalone with `rustc`
and stays out of the Cargo workspace.

```
rustc -O daemon-proto.rs -o /tmp/daemon-proto && /tmp/daemon-proto
```

Proves: one long-lived daemon multiplexes many short-lived plugin connections
over a single socket; decisions route back to the correct plugin by request id
even when delivered out of order; the local-terminal decision wins its race and
is relayed upstream while purely-remote decisions are not.

The daemon's single upstream connection to the broker is simulated in-process
here; its real SSE/long-poll behavior is what `broker-proto.mjs` covers. The two
prototypes meet end-to-end at the broker boundary.
