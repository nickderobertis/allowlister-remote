# AGENTS — `crates/allowlister-remote-protocol`

The protocol-v3 **wire contract** (`type:contract`): the one authoritative
definition of every JSON envelope the plugin, daemon, broker and PWA exchange.

- **Depends on no consumer** — only `serde_json`. The boundary check rejects an
  edge from here to the plugin, daemon, broker, e2e or web projects.
- **The binaries build and parse through it**: use its builders, `Verdict`, and
  field/kind constants instead of restating names.
- **`wire/protocol-v3.json` is the fixed wire definition**, captured from the tree
  before this crate existed. Changing the protocol means changing the builder, the
  fixture and the web restatements in one deliberate change; the allowlister
  payload is forwarded verbatim and the format is a cross-repo contract, so never
  change it unilaterally.
- `crates/allowlister-remote-protocol` (`type:contract`) is the protocol-v3 wire contract's one
  source: the plugin, daemon, and broker build and parse every envelope through it, and its
  `wire/protocol-v3.json` (captured from the pre-contract tree) pins the bytes. Drift checks:
  `tests/wire_golden.rs` (Rust) and `apps/web/src/protocol-contract.test.ts` (the web app's
  restatements). It depends on no consumer.
