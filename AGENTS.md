# AGENTS

`allowlister-remote` is a standalone progressive web app for remote approval of
allowlister dynamic approval requests.

## Stack and composition

- **Product shape:** Installable web app/PWA plus a small typed API contract for
  an allowlister approval bridge.
- **Languages:** TypeScript and React for the app; shell command surface via
  `just`.
- **References composed:** `shapes/web-app.md`, `languages/typescript.md`, and
  `ci.md` from the create-repo skill.
- **Excluded, and why:** Server persistence and push-notification delivery are
  intentionally outside this first repo scaffold; the app targets any bridge that
  implements the documented HTTP contract.

## Command surface

Use `just`; do not hand-roll equivalent commands.

- `just bootstrap` installs dependencies.
- `just check` runs formatting, linting, type checking, tests, and production
  build.
- `just test` runs the deterministic Vitest suite.
- `just test-e2e` runs Playwright against the built PWA in desktop and mobile Chromium.
- `just dev` starts the Vite dev server.

## Quality and tests

- Keep TypeScript strict and boundary types explicit.
- Tests cover the approval decision flow, request summarization, API client, and
  offline/demo behavior. Coverage gates enforce 95% lines/statements, 90% functions, and 80% branches. Line coverage keeps the create-repo default bar while branch coverage stays focused on meaningful UI paths.
- The production build must include the PWA manifest and service worker.
- E2E must exercise the real browser approval flow in both desktop and mobile viewports.
