# AGENTS

`allowlister-remote` is an Nx monorepo for remote approval of
allowlister dynamic approval requests.

## Stack and composition

- **Product shape:** Nx monorepo containing a static Next.js PWA plus a Rust
  allowlister dynamic plugin client, a host daemon, and a broker. The broker is
  the only transport for approval requests: the plugin hands each request to the
  per-host daemon over local IPC (a Unix socket or a Windows named pipe), the
  daemon holds one WebSocket to the broker, and the PWA connects to the broker
  over a WebSocket (via its service worker). There is no HTTP polling fallback.
- **The PWA has no server of its own.** It builds to a fully static bundle
  (`output: "export"` → `apps/web/out`); the broker is the only backend. The
  broker URL is a client-side setting the browser holds (localStorage, seeded by a
  `?broker=` deep link or a build-time `NEXT_PUBLIC_ALLOWLISTER_REMOTE_BROKER_URL`
  default), resolved in `apps/web/src/lib/broker-config.ts`. With nothing
  configured the app shows a one-time broker-setup screen. There are no Next API
  routes.
- **Distribution.** The plugin and daemon ship on npm (per-platform native
  packages under the parent `@nickderobertis/allowlister-remote-plugin`). The
  static PWA ships as its own npm package `@nickderobertis/allowlister-remote-web`
  (a tiny static server plus the prebuilt bundle; `npx` it or drop it on any
  static host). The broker is a server-side standalone Rust CLI distributed via
  GitHub Releases with a cross-platform `scripts/install-broker.sh`, the same way
  `nickderobertis/allowlister` ships its CLI — not on npm.
- **Languages:** TypeScript, React, and Next.js for the app; Rust for the
  allowlister plugin client, daemon, and broker; shell command surface via `just`.
- **References composed:** `shapes/web-app.md`, `languages/typescript.md`, `ci.md`,
  `references/releasing.md`, and `references/monorepo.md` from the create-repo skill.
- **Out of scope (today), and why:** Durable multi-user persistence, broker
  authentication, and push-notification delivery are not yet built; the broker
  holds pending request state in memory and serves any connected daemon/PWA. The
  broker also terminates plain `ws://` and expects a TLS-terminating proxy in
  front for `wss://` (the daemon trusts a private CA via
  `ALLOWLISTER_REMOTE_BROKER_CA`). See **Follow-ups** below for what closing each
  gap entails.

## Command surface

Use `just`; do not hand-roll equivalent commands.

- `just bootstrap` installs JavaScript dependencies and fetches Rust workspace dependencies.
- `just check` wraps `nx affected` for formatting, linting, type checking, tests, production builds, and e2e so only affected projects run.
- `just test` runs the deterministic Vitest suite.
- `just test-e2e` runs Playwright against the built PWA driving the real broker,
  daemon, and plugin binaries (the full broker WebSocket path) in desktop and
  mobile Chromium.
- `just dev` delegates to `nx run web:dev`.
- `just smoke-e2e [version]` builds the app and runs the broker-realtime e2e against the
  plugin package installed from the public npm registry (defaults to the latest version).
- `just bench` / `just bench-allocs` run the Rust plugin's informational performance
  suite — Criterion micro-benchmarks and a deterministic allocation report over the
  pure decision path — while `just bench-cli` (hyperfine), `just bench-instructions`
  (cachegrind), and `just profile` (samply / callgrind) cover end-to-end CLI latency,
  deterministic instruction counts, and sampling profiles. See the plugin's `benches/`
  and `scripts/{bench,bench-instructions,profile}.sh`. The `Performance` workflow
  (`bench.yml`) runs these on PRs that affect the plugin and posts the numbers as a sticky
  comment plus a job summary; it is informational, never a required check.
- `just bench-web` / `just bundle-size` / `just lighthouse` run the PWA's parallel
  performance suite: Vitest micro-benchmarks of the pure decision/summarization surface
  (`apps/web/src/perf/*.bench.ts`), a deterministic gzip bundle-size report
  (`scripts/web-bundle-size.mjs`), and a Lighthouse runtime audit
  (`scripts/web-lighthouse.mjs`). The same `Performance` workflow `web` job runs all three
  on PRs that affect web and posts its own sticky comment plus job summary; like the plugin
  suite it is informational, never a required check. Bundle size is the deterministic, trustworthy
  delta (the web counterpart of the plugin's cachegrind instruction counts); the Vitest and
  Lighthouse numbers are absolute and noise-prone, so treat small deltas with caution.
- Release helpers live behind `npm run release:*`; tags, GitHub Releases, and npm publishing run in Actions.

## Quality and tests

- Keep TypeScript strict and boundary types explicit.
- Tests cover the approval decision flow, request summarization, the broker
  bridge (the PWA's only request source, driven through a mocked bridge with raw
  protocol-v3 payloads), and offline behavior. Coverage gates enforce 95% lines/statements, 90% functions, and 80% branches. Line coverage keeps the create-repo default bar while branch coverage stays focused on meaningful UI paths.
- The production build must include the PWA manifest and service worker.
- The plugin's performance suite is informational, not a gate: it benches the pure,
  network-free decision surface (`triage`, `build_create_body`, `interpret_decision`,
  `parse_local_input`) so the numbers track what the binary runs between stdin and the
  daemon. `harness = false` keeps the bench targets out of the test runner and
  coverage; `--all-targets` lint/typecheck keep them compiling.
- E2E must exercise the real browser approval flow in both desktop and mobile
  viewports through the actual allowlister plugin process, the host daemon, and
  the broker over a WebSocket — remote allow/deny decisions (from both the inbox
  and the expanded detail view, for shell and tool calls) and static allow/deny
  no-wait paths.
- Approvals have no timeout: the plugin waits indefinitely and presents
  the same request at the local terminal (via `/dev/tty`) and in the web app at the
  same time. Whichever side decides first wins; a local-terminal decision is
  relayed up through the daemon to the broker so the pending web approval is dismissed.
- The visual-docs gallery (screencomp) captures both approval surfaces. The web lane
  is Playwright (`apps/web/screenshots/*.capture.ts`); the **terminal lane**
  (`terminal.capture.ts`) renders the plugin's real `/dev/tty` prompt to a vector
  **SVG** instead of a rasterized terminal screenshot — there is no CPU font
  rasterization, so its bytes are byte-identical across CI's heterogeneous runners
  (the determinism the strict gate needs; the web lane fights the same cross-CPU
  jitter with deviceScaleFactor supersampling). The prompt text is a committed
  fixture (`screenshots/terminal/prompts.json`) recorded from the genuine binary by
  `just record-terminal-prompts`; `crates/.../tests/terminal_prompt.rs` asserts the
  live `local_prompt` still reproduces it, so the gallery can never depict a prompt
  the plugin no longer emits. Terminal shots carry only the `theme` toggle (a
  terminal frame is not responsive), so viewport is a screencomp wildcard.
- After a release publishes, the `e2e-smoke` workflow re-runs the broker-realtime e2e
  against the plugin package downloaded from the public npm registry (rather than a
  locally built binary), so the published artifact is verified end-to-end. It first
  asserts the installed `allowlister-remote-plugin` command resolves directly to the
  native Rust binary (no Node launcher in the hot path) and that the daemon ships
  next to it, then points `ALLOWLISTER_REMOTE_PLUGIN_BIN`/`ALLOWLISTER_REMOTE_DAEMON_BIN`
  at those resolved binaries so the e2e drives the real Rust plugin and daemon against a
  source-built broker.

## Monorepo projects

- `apps/web` is the static Next.js PWA project (`output: "export"`, no server of its own) and owns
  the browser, UI, and service-worker tests. Its e2e and visual-docs capture serve the built
  `out/` bundle with the zero-dep `scripts/serve-web.mjs` and seed the broker URL client-side
  (localStorage) before navigating.
- `crates/allowlister-remote-plugin` is the Rust allowlister dynamic plugin client. It is
  network-free: it hands each request to the daemon over local IPC and never opens a socket
  to the broker itself.
- `crates/allowlister-remote-daemon` is the per-host daemon: one long-lived process that
  multiplexes the host's ephemeral plugin processes onto a single supervised WebSocket to the
  broker, re-announcing still-pending requests on reconnect. Plugin↔daemon is a Unix socket on
  Unix and a named pipe on Windows (a transport-generic `handle_plugin` serves both).
- `crates/allowlister-remote-broker` is the standalone WebSocket broker (`/ws/daemon`, `/ws/pwa`,
  `/healthz`); it holds pending requests in memory and mediates between daemons and PWAs. It ships
  as a server-side CLI on GitHub Releases (built for all three platforms in `publish.yml`), not on
  npm; `scripts/install-broker.sh` is the cross-platform installer (detect platform → download the
  release binary + `SHA256SUMS` → checksum-verify → install), mirroring `allowlister`'s install
  flow. Its `--version` is stamped from the tag via `ALLOWLISTER_REMOTE_PLUGIN_VERSION`, like the
  plugin and daemon. The listen address comes from `ALLOWLISTER_REMOTE_BROKER_ADDR`.
- `crates/allowlister-remote-e2e` drives the real broker + daemon + plugin binaries through the
  full chain.
- `packages/allowlister-remote-web` is the npm package for the static PWA: a zero-dependency static
  server (`bin/serve.mjs`) plus the prebuilt `out/` bundle vendored into `static/` at release time.
  Run it with `npx @nickderobertis/allowlister-remote-web` (or host the assets anywhere) and point
  it at a broker in the app. It is not a workspace member, so its publish-time version never drifts
  the dev lockfile.
- `packages/allowlister-remote-plugin` is the parent npm package users install; it carries
  only a small JS launcher plus an `install.mjs` that links the native binaries onto the command path.
- `packages/allowlister-remote-plugin-{darwin-arm64,linux-x64,win32-x64}` are the per-platform npm
  packages that each ship the release-built plugin **and** daemon binaries (the plugin auto-starts
  the daemon as a sibling on every OS), gated by `os`/`cpu`. The parent declares
  them as optional dependencies so npm installs only the one matching the host. These are published
  from their directories (not workspace members) so their `os`/`cpu` gates do not break dev installs.
- The `linux-x64` binary is a fully static **musl** build (`x86_64-unknown-linux-musl`, see
  `publish.yml`): it embeds libc so it carries no glibc version floor (runs on Alpine/distroless/old
  distros) and skips the dynamic loader entirely. The plugin is spawned once per gated command, so
  dropping `ld.so` cuts the no-network hot path ~75% in instruction count; the modest size cost
  (~9%) is a favorable trade. The crate's `build.rs` instead links the glibc dev binary `-no-pie`,
  which removes load-time relocations there; the static musl build is already relocation-light and
  needs no such flag.
- Native binaries are vendored into the per-platform packages only at release time and are never
  committed; `npm run release:stage-npm` stages them from the downloaded release artifacts. The PWA
  bundle is likewise vendored into the web package only at release time: `npm run release:stage-web`
  builds nothing itself but copies a prebuilt `apps/web/out` into `packages/allowlister-remote-web/static`
  and stamps the version. Both `apps/web/out` and the web package's `static/` are gitignored.
- Root commands must delegate to Nx affected/run targets; do not add bespoke root loops over projects.
- Affected-only is the default for everything CI does — fmt, lint, typecheck, test, build, e2e,
  and perf (`bench.yml` gates each lane on its package via the `changes` job). The sole exception is
  release/deploy validation: `install-smoke`, `e2e-smoke`, and `publish` build and verify **every**
  package every time on purpose, because lockstep `vX.Y.Z` versioning ships them as a set.
- Each project's targets touch only its own files: per-crate Rust commands are `-p <crate>` scoped,
  and a project's `biome`/`tsc` paths never reach into another project's tree. Shared root files
  (`scripts/`, root configs) have exactly one owner (`web`); `packages/**` is owned solely by
  `allowlister-remote-plugin-npm`. This keeps an affected run from re-checking another package.

## Commits, releases, and merging

- PR titles use Conventional Commits and are required because squash commits drive releases.
- Pre-1.0 bump policy: `feat` and breaking changes create a minor; `fix`, `perf`,
  `refactor`, and `build` create a patch; chores/docs/tests/styles do not release.
- Release Please tracks the whole repo (root `.` package, `simple` release-type), so both
  web (`apps/web`) and plugin (`crates/**`) commits drive a single `vX.Y.Z` release. It
  owns the changelog, `.release-please-manifest.json`, and the tag only — it does not edit
  any Cargo file, so `Cargo.toml`/`Cargo.lock` never drift and every `--locked` bench step
  stays green. The crate `Cargo.toml` keeps a `0.0.0` placeholder; the published binary's
  version is the git tag, injected at compile time via `ALLOWLISTER_REMOTE_PLUGIN_VERSION`
  (`option_env!` in `main.rs`, set by `publish.yml`) — the same stamp-from-tag pattern every
  release binary (plugin, daemon, **and** broker) and every npm package uses, so `--version`
  matches the npm/release version across the board.
- After the required checks (`check`, `install-smoke`, `pr-title`, and `Visual docs / visual-docs`) pass, Release Please opens or updates a release PR with `RELEASE_TOKEN` and turns on squash **auto-merge**, so the PR merges itself once required checks pass — no manual click. Merging tags `vX.Y.Z`, which fires `publish.yml`. That tag build does three things, all stamped from the tag: (1) it builds the plugin, daemon, and **broker** for all three platforms and attaches them — with `SHA256SUMS` — to the **GitHub Release** (the broker's only distribution channel, consumed by `scripts/install-broker.sh`); (2) it stages and publishes the per-platform native npm packages followed by the parent `@nickderobertis/allowlister-remote-plugin` (which depends on them) with `NPM_TOKEN`; and (3) in a parallel `web-publish` job it builds the static PWA export, stages it into `@nickderobertis/allowlister-remote-web`, and publishes that package. The web package has no native binaries and no dependency on the plugin packages, so it publishes independently.
- GitHub should stay squash-only with auto-merge, branch deletion, required `check`,
  `install-smoke`, `pr-title`, and `Visual docs / visual-docs` checks, linear
  history, conversation resolution, and admin override.
- `gh-secrets.json` is the secret manifest; values stay in the local gh-secrets store or another configured source, never in git.

## Follow-ups (known gaps to close)

Every component now releases automatically — the plugin and daemon to npm, the
broker to GitHub Releases (with an install script), and the static PWA to npm.
What is **not** yet done, and what closing each gap entails:

- **Broker durability and auth.** The broker keeps pending request state in
  memory and accepts any daemon/PWA that connects. Multi-instance or
  restart-survivable operation needs durable shared state, and any real
  deployment needs authn/authz on `/ws/daemon` and `/ws/pwa` (e.g. a shared
  token or per-user identity). Until then, run a single broker instance behind a
  trusted boundary.
- **Broker TLS.** The broker serves plain `ws://`; `wss://` requires a
  TLS-terminating proxy in front (the daemon trusts a private CA via
  `ALLOWLISTER_REMOTE_BROKER_CA`). Terminating TLS in the broker itself, or a
  documented proxy recipe, would remove that external dependency.
- **PWA hosting.** The PWA is a static bundle but nothing hosts it for users yet
  — it must be `npx`-served, dropped on a static host/CDN, or self-hosted, then
  pointed at a broker. A managed deployment (and a place to host the broker) is
  still open.
- **Push delivery.** Approvals surface only while the PWA is open (or at the
  local terminal). Web Push / notifications so a request can reach a backgrounded
  device are not implemented.
- **Windows named-pipe daemon.** The plugin↔daemon named-pipe backend compiles
  behind `cfg(windows)` but is only built by `publish.yml`'s release matrix, not
  by any PR check, so it needs verification on a Windows runner before it is
  relied on.
- **Post-release broker smoke.** `e2e-smoke` drives the *published* plugin and
  daemon but still builds the broker from source; it could instead install the
  published broker via `scripts/install-broker.sh` to verify that artifact too.
- **Visual-docs baselines.** The static-export switch changes how the app is
  served during capture; if the byte-identical gallery gate drifts, regenerate
  the baselines in the pinned Playwright image (`screencomp`), not locally.
