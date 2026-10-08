# AGENTS — `apps/web-e2e`

The browser e2e suite (`type:e2e`): Playwright driving the built static PWA
(`apps/web/out`) against the real broker, daemon and plugin binaries, in desktop
and mobile Chromium. Run it with `just test-e2e`.

- It is its own project so a crate change re-runs it without re-running `web`'s
  lint, typecheck, unit tests or build; keep `web` free of crate edges.
- E2E must exercise the real browser approval flow in both desktop and mobile
  viewports (the `chromium-desktop` and `mobile-chrome` projects) through the actual allowlister plugin process, the host daemon, and
  the broker over a WebSocket — remote allow/deny decisions (from both the inbox
  and the expanded detail view, for shell and tool calls) and static allow/deny
  no-wait paths.
- It and the capture serve the built `out/` bundle with `scripts/serve-web.mjs`
  and seed the broker URL client-side (localStorage) before navigating.
- `specs/broker-harness.ts` spawns the binaries and honours the
  `ALLOWLISTER_REMOTE_*_BIN` overrides the post-release smoke uses. The visual-docs
  capture is not here: it stays `web:capture`.
