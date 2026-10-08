# AGENTS — `crates/allowlister-remote-protocol`

The protocol-v3 **wire contract** (`type:contract`): the one authoritative
definition of every JSON envelope the plugin, daemon, broker and PWA exchange.
Root-level guidance lives in the repo `AGENTS.md`.

- **Depends on no consumer.** Only `serde_json`; never a path dependency on the
  plugin, daemon, broker, e2e or web projects. The tag-based boundary check
  (`scripts/check-project-boundaries.mjs`, run by `just check`) rejects such an
  edge in the Nx graph.
- **The binaries build and parse through it.** The plugin, daemon and broker use
  this crate's builders (`plugin_create`, `broker_create`, `decision`, `added`, …)
  and field/kind constants instead of restating names.
- **`wire/protocol-v3.json` is the fixed wire definition.** It was captured from
  the tree before this crate existed (the plugin binary's real `create` line and
  the daemon's and broker's envelope functions, byte for byte).
  `tests/wire_golden.rs` rebuilds every envelope and fails on any byte of drift,
  so a field or envelope change fails even when every consumer adopts it.
- **The web app is checked against the same file.**
  `apps/web/src/protocol-contract.test.ts` drives the TypeScript bridge, the
  payload normalizer and `public/sw.js` with the fixture's frames and fails when
  any restatement disagrees.
- **Changing the protocol is deliberate**: edit the builder, the fixture, and the
  web restatements in one change. The wire format is a cross-repo contract (the
  allowlister payload is forwarded verbatim), so do not change it unilaterally.
