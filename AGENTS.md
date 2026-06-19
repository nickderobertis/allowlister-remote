# AGENTS

`allowlister-remote` is an Nx monorepo for remote approval of
allowlister dynamic approval requests.

## Stack and composition

- **Product shape:** Nx monorepo containing a Next.js web app/PWA with server
  API endpoints plus a Rust allowlister dynamic plugin client.
- **Languages:** TypeScript, React, and Next.js for the app/server; Rust for the
  allowlister plugin client; shell command surface via `just`.
- **References composed:** `shapes/web-app.md`, `languages/typescript.md`, `ci.md`,
  `references/releasing.md`, and `references/monorepo.md` from the create-repo skill.
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
- `just smoke-e2e [version]` builds the app and runs the approval-flow e2e against the
  plugin package installed from the public npm registry (defaults to the latest version).
- `just bench` / `just bench-allocs` run the Rust plugin's informational performance
  suite — Criterion micro-benchmarks and a deterministic allocation report over the
  pure decision path — while `just bench-cli` (hyperfine) and `just profile` (samply /
  callgrind) cover end-to-end CLI latency and sampling profiles. See the plugin's
  `benches/` and `scripts/{bench,profile}.sh`.
- Release helpers live behind `npm run release:*`; tags, GitHub Releases, and npm publishing run in Actions.

## Quality and tests

- Keep TypeScript strict and boundary types explicit.
- Tests cover the approval decision flow, request summarization, API client, and
  offline/demo behavior. Coverage gates enforce 95% lines/statements, 90% functions, and 80% branches. Line coverage keeps the create-repo default bar while branch coverage stays focused on meaningful UI paths.
- The production build must include the PWA manifest and service worker.
- The plugin's performance suite is informational, not a gate: it benches the pure,
  network-free decision surface (`triage`, `build_create_body`, `interpret_decision`,
  `parse_local_input`) so the numbers track what the binary runs between stdin and the
  network. `harness = false` keeps the bench targets out of the test runner and
  coverage; `--all-targets` lint/typecheck keep them compiling.
- E2E must exercise the real browser approval flow in both desktop and mobile
  viewports through the actual allowlister binary, Rust plugin process, Next.js app
  server over HTTP, remote allow/deny decisions, and static allow/deny no-wait
  paths.
- Approvals have no timeout by default: the plugin waits indefinitely and presents
  the same request at the local terminal (via `/dev/tty`) and in the web app at the
  same time. Whichever side decides first wins; a local-terminal decision is posted
  back to the server so the pending web approval is dismissed. A positive
  `--timeout-ms` opts back into bounded waiting.
- After a release publishes, the `e2e-smoke` workflow re-runs the approval-flow e2e
  against the plugin package downloaded from the public npm registry (rather than a
  locally built binary), so the published artifact is verified end-to-end. It first
  asserts the installed `allowlister-remote-plugin` command resolves directly to the
  native Rust binary (no Node launcher in the hot path), then points
  `ALLOWLISTER_REMOTE_PLUGIN_BIN` at that resolved binary so the e2e drives Rust directly.

## Monorepo projects

- `apps/web` is the Next.js PWA/server project and owns browser, route, and UI tests.
- `crates/allowlister-remote-plugin` is the Rust allowlister dynamic plugin client.
- `packages/allowlister-remote-plugin` is the parent npm package users install; it carries
  only a small JS launcher plus an `install.mjs` that links the native binary onto the command path.
- `packages/allowlister-remote-plugin-{darwin-arm64,linux-x64,win32-x64}` are the per-platform npm
  packages that each ship one release-built native binary, gated by `os`/`cpu`. The parent declares
  them as optional dependencies so npm installs only the one matching the host. These are published
  from their directories (not workspace members) so their `os`/`cpu` gates do not break dev installs.
- Native binaries are vendored into the per-platform packages only at release time and are never
  committed; `npm run release:stage-npm` stages them from the downloaded release artifacts.
- Root commands must delegate to Nx affected/run targets; do not add bespoke root loops over projects.

## Commits, releases, and merging

- PR titles use Conventional Commits and are required because squash commits drive releases.
- Pre-1.0 bump policy: `feat` and breaking changes create a minor; `fix`, `perf`,
  `refactor`, and `build` create a patch; chores/docs/tests/styles do not release.
- After the main `check` workflow passes, Release Please opens or updates a release PR with `RELEASE_TOKEN`; merging that PR tags `vX.Y.Z`, then the tag builds GitHub Release binaries, stamps every npm package from the tag, and publishes the per-platform packages followed by the parent `@nickderobertis/allowlister-remote-plugin` (which depends on them) with `NPM_TOKEN`.
- GitHub should stay squash-only with auto-merge, branch deletion, required `check`,
  `install-smoke`, and `pr-title` checks, linear history, conversation resolution, and admin override.
- `gh-secrets.json` is the secret manifest; values stay in the local gh-secrets store or another configured source, never in git.
