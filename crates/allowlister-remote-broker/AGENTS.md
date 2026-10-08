# AGENTS — `crates/allowlister-remote-broker`

- `crates/allowlister-remote-broker` is the standalone WebSocket broker (`/ws/daemon`, `/ws/pwa`,
  `/healthz`); it holds pending requests in memory and mediates between daemons and PWAs. It ships
  as a server-side CLI on GitHub Releases (built for all three platforms in `publish.yml`), not on
  npm; `scripts/install-broker.sh` is the cross-platform installer (detect platform → download the
  release binary + `SHA256SUMS` → checksum-verify → install), mirroring `allowlister`'s install
  flow. Its `--version` is stamped from the tag via `ALLOWLISTER_REMOTE_PLUGIN_VERSION`, like the
  plugin and daemon. The listen address comes from `ALLOWLISTER_REMOTE_BROKER_ADDR`.
