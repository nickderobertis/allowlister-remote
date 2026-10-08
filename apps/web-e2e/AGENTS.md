# AGENTS — `apps/web-e2e`

Playwright, run with `just test-e2e`.

- Keep `web` free of crate edges.
- `apps/web-e2e` (`type:e2e`) is the browser e2e suite, its own project so a crate change
  re-runs it without re-running `web`'s targets; `test-e2e` builds `web` and the three crates
  first. It and the capture serve the built `out/` bundle with `scripts/serve-web.mjs` and seed
  the broker URL client-side (localStorage) before navigating.
- E2E must exercise the real browser approval flow in both desktop and mobile
  viewports through the actual allowlister plugin process, the host daemon, and
  the broker over a WebSocket — remote allow/deny decisions (from both the inbox
  and the expanded detail view, for shell and tool calls) and static allow/deny
  no-wait paths. It must pass in both the `chromium-desktop` and `mobile-chrome`
  projects, and the keyboard affordances must not appear or block interaction in the
  mobile viewport.
- `specs/broker-realtime.spec.ts` spawns the real broker, daemon, and plugin binaries and drives
  the full broker WebSocket path (allow/deny from the inbox and detail view, shell and tool
  calls); `pwa.spec.ts` and `theme.spec.ts` cover the offline shell and theming.
- `specs/broker-harness.ts` spawns the binaries and honours the
  `ALLOWLISTER_REMOTE_*_BIN` overrides. The visual-docs capture is not here: it stays
  `web:capture`.
- After a release publishes, the `e2e-smoke` workflow (through `scripts/smoke-e2e-published.sh`)
  re-runs this suite against the published artifacts, never source builds. It
  asserts the npm-installed `allowlister-remote-plugin` command resolves directly to the native
  Rust binary (no Node launcher in the hot path) with the daemon beside it, and installs the
  broker with `scripts/install-broker.sh --version v<tag>` (checksum-verified, the installer
  users run) and asserts its tag-stamped `--version`; `ALLOWLISTER_REMOTE_PLUGIN_BIN`,
  `ALLOWLISTER_REMOTE_DAEMON_BIN` and `ALLOWLISTER_REMOTE_BROKER_BIN` point at those binaries.
