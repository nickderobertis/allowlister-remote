# AGENTS — `apps/web-e2e`

The browser end-to-end suite (`type:e2e`): Playwright driving the built static
PWA (`apps/web/out`) against the **real** broker, daemon and plugin binaries over
the broker WebSocket, in desktop and mobile Chromium. Root-level guidance lives in
the repo `AGENTS.md`; UI conventions live in `apps/web/AGENTS.md`.

- **Why it is its own project.** It is the slow, external-process tier. Keeping
  it out of `web` means a change to one crate re-runs this suite (it depends on
  `web` and the plugin, broker and daemon) without re-running `web`'s lint,
  typecheck, unit tests or build — `web` has no edge to any crate.
- **What runs first.** `test-e2e` depends on `web:build` and the three crates'
  `build`, so it always drives freshly built artifacts. Run it with
  `npx nx run web-e2e:test-e2e` (or `just test-e2e`).
- **Nothing depends on this project.** The tag-based boundary check rejects any
  edge onto a `type:e2e` project.
- **Layout.** `specs/` holds the specs and `broker-harness.ts` (which spawns the
  binaries, honouring the `ALLOWLISTER_REMOTE_*_BIN` overrides the post-release
  smoke uses); `playwright.config.ts` serves `../web/out` with
  `scripts/serve-web.mjs`. The visual-docs capture is not here: it stays
  `web:capture` (`apps/web/playwright.capture.config.ts`).
- Only `playwright.config.ts` is type-checked (as it was under `web`); the
  specs need strict-mode fixes before `tsconfig.json` can include them.
