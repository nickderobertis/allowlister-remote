# AGENTS

`allowlister-remote` is an Nx monorepo for remote approval of
allowlister dynamic approval requests.

## Stack and composition

- **Product shape:** Nx monorepo containing a Next.js web app/PWA with server
  API endpoints plus a Rust allowlister dynamic plugin client.
- **Languages:** TypeScript, React, and Next.js for the app/server; Rust for the
  allowlister plugin client; shell command surface via `just`.
- **References composed:** `shapes/web-app.md`, `languages/typescript.md`, `ci.md`, and
  `references/monorepo.md` from the create-repo skill.
- **Excluded, and why:** Durable multi-user persistence, auth, and push-notification delivery are
  intentionally outside this first repo scaffold; the server keeps in-memory
  request state for local and CI-realistic approval journeys.

## Command surface

Use `just`; do not hand-roll equivalent commands.

- `just bootstrap` installs JavaScript dependencies and fetches Rust workspace dependencies.
- `just check` wraps `nx affected` for formatting, linting, type checking, tests, production builds, and e2e so only affected projects run.
- `just test` runs the deterministic Vitest suite.
- `just test-e2e` runs Playwright against the built PWA and the real
  allowlister binary/plugin boundary in desktop and mobile Chromium.
- `just dev` delegates to `nx run web:dev`.

## Quality and tests

- Keep TypeScript strict and boundary types explicit.
- Tests cover the approval decision flow, request summarization, API client, and
  offline/demo behavior. Coverage gates enforce 95% lines/statements, 90% functions, and 80% branches. Line coverage keeps the create-repo default bar while branch coverage stays focused on meaningful UI paths.
- The production build must include the PWA manifest and service worker.
- E2E must exercise the real browser approval flow in both desktop and mobile
  viewports through the actual allowlister binary, Rust plugin process, Next.js app
  server over HTTP, remote allow/deny decisions, and static allow/deny no-wait
  paths.

## Monorepo projects

- `apps/web` is the Next.js PWA/server project and owns browser, route, and UI tests.
- `crates/allowlister-remote-plugin` is the Rust allowlister dynamic plugin client.
- Root commands must delegate to Nx affected/run targets; do not add bespoke root loops over projects.
