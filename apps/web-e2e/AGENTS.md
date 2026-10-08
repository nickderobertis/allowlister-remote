# AGENTS — `apps/web-e2e`

The browser e2e suite (`type:e2e`): Playwright driving the built static PWA
(`apps/web/out`) against the real broker, daemon and plugin binaries, in desktop
and mobile Chromium. Run it with `just test-e2e`.

- It is its own project so a crate change re-runs it without re-running `web`'s
  lint, typecheck, unit tests or build; keep `web` free of crate edges.
- `specs/broker-harness.ts` spawns the binaries and honours the
  `ALLOWLISTER_REMOTE_*_BIN` overrides the post-release smoke uses. The visual-docs
  capture is not here: it stays `web:capture`.
