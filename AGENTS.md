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
- `just dev` starts the Vite dev server.

## Quality and tests

- Keep TypeScript strict and boundary types explicit.
- Tests cover the approval decision flow, request summarization, API client, and
  offline/demo behavior. Coverage gates are 85% statements/lines/functions and
  60% branches because the PWA shell has responsive and error UI branches that
  are better guarded by focused component tests than brittle DOM branch counts.
- The production build must include the PWA manifest and service worker.
