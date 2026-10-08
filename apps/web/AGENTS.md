# AGENTS — `apps/web`

The Next.js PWA project — a **fully static export** (`output: "export"`, no
server of its own). It owns the browser UI and the browser/route/UI tests.
Root-level guidance lives in the repo `CLAUDE.md`; this file documents conventions
specific to the web app.

## Project boundaries

- `apps/web` is the static Next.js PWA project (`output: "export"`, no server of its own) and owns
  the UI and service-worker unit tests and the visual-docs capture (`web:capture`). It has no
  edge to any crate. It is its own npm workspace package (`apps/web/package.json` declares every
  dependency the app uses); the root `package.json` keeps only repo tooling (Nx, Biome, knip,
  the root scripts' Lighthouse deps, `yaml`), and `web-e2e` declares its own.

## Structure & imports

`src/App.tsx` is the thin orchestrator (state, effects, the `MainView` view
selector); the views live under `src/components/` so no single file is a monolith:

- `src/components/approval/` — `inbox.tsx`, `detail.tsx` (`ShellDetail` /
  `ToolDetail`), `shortcuts.tsx`, and `shared.tsx` (presentational primitives,
  the `Verdict`/`RequestProps`/`DetailChromeProps` types).
- `src/components/broker-setup.tsx`, `connection-status.tsx`, `error-screen.tsx`.

Intra-app imports use the **`@/*` path alias** (→ `apps/web/src`, configured in
`tsconfig.json` and `vitest.config.ts`); reach for `@/…` rather than `../../`
chains. Co-located siblings may stay relative (`./shared`).

## Approval UI shape

The single-page approval UI has these states:

- **Broker setup** (`BrokerSetup`) — first-run screen to enter the broker URL
  (validated as `ws://`/`wss://` by `isValidBrokerBase`); reused, with a Cancel,
  to change the broker later via the **Broker** control in the top bar.
- **Inbox** — a list of pending approvals, each card opening a detail view or
  being allowed/denied inline. Its header shows the live broker
  `ConnectionStatus` (connecting / connected / reconnecting) so an unreachable
  broker is distinct from an idle inbox.
- **Detail** — one approval, either a shell script (`ShellDetail`) or a tool
  call (`ToolDetail`), with allow/deny and view-specific controls.
- **Empty** — the resting state with no pending approvals.

`page.tsx` mounts `App`, which connects to the broker (the only request source)
using the client-held URL resolved by `src/lib/broker-config.ts` (a `?broker=`
deep link, `localStorage`, or a build-time default) and renders whatever the
broker relays. There is no demo/offline data path; unit tests drive it through a
mocked broker bridge (`src/test/broker-fixtures.ts`).

## Error & not-found boundaries

`app/error.tsx`, `app/global-error.tsx`, and `app/not-found.tsx` are the App
Router boundaries; they share the token-styled `ErrorScreen` so a render-time
throw (or a 404) shows a recoverable screen instead of blanking the static
bundle. Keep them client-safe and free of broker/state assumptions.

## Keyboard navigation (desktop only)

The whole app is operable from the keyboard on desktop, and **every shortcut is
shown in the UI** so it is discoverable without external docs. Keep this
invariant: if you add an action, give it a visible shortcut and document it in
`SHORTCUT_GROUPS`.

### Desktop-only gating

Keyboard navigation and all shortcut hints are gated behind `useIsDesktop()`
(`src/lib/keyboard.ts`), which matches `(min-width: 768px) and (pointer: fine)`.
Touch/mobile devices report a coarse pointer, so they never bind global keys or
render key caps — the inbox stays tap-first there. Anything keyboard-related
must render only when `isDesktop` is true (pass it down as `showHints` /
`keyboardEnabled`), and never as a mobile affordance.

### Shortcuts

| Context          | Keys            | Action                                   |
| ---------------- | --------------- | ---------------------------------------- |
| Global           | `?`             | Show / hide the shortcuts panel          |
| Inbox            | `J` / `↓`       | Focus the next approval                  |
| Inbox            | `K` / `↑`       | Focus the previous approval              |
| Inbox            | `Enter` / `O`   | Open the focused approval                |
| Inbox            | `A`             | Allow the focused approval               |
| Inbox            | `D`             | Deny the focused approval                |
| Approval detail  | `A`             | Allow the request                        |
| Approval detail  | `D`             | Deny the request                         |
| Approval detail  | `Esc` / `B`     | Back to the inbox                        |
| Tool detail      | `F` / `J`       | Switch to the formatted / JSON view      |
| Shell detail     | `S`             | Show / hide the full script              |

The inbox keeps a "cursor" (`focusedIndex`) that `J`/`K`/arrows move and that
the mouse follows on hover; the focused card is ringed and marked
`aria-current="true"`. `A`/`D`/`Enter`/`O` act on that focused card.

### Discoverability surfaces

- Inline `Kbd` key caps next to the focused card's buttons, the detail
  allow/deny/back/view controls, and the "show full script" summary.
- A short hint line under the inbox header (`InboxHints`).
- A floating **Shortcuts `?`** button (`ShortcutsHint`).
- A full shortcuts panel (`ShortcutsOverlay`, `role="dialog"`) driven by the
  single source of truth `SHORTCUT_GROUPS`, opened with `?` or the floating
  button and closed with `Esc` or its close control.

### Implementation notes

- `useKeyboardShortcuts(map, enabled)` binds one document `keydown` listener and
  dispatches by `event.key`. It reads handlers from a ref, so callers may pass a
  fresh map each render. It ignores events while a modifier is held or while
  focus is on a form field / interactive control (so native Tab + Enter/Space
  keeps working), but always lets `Escape` through so overlays can be dismissed.
- Shortcut maps use **named handler references** for capitalized keys
  (`Enter`, `Escape`, `ArrowDown`, …); inline arrow functions on PascalCase
  object keys trip Biome's `noNestedComponentDefinitions` rule.
- `Kbd` (`src/components/ui/kbd.tsx`) is the only key-cap primitive. Buttons that
  embed a `Kbd` carry an explicit `aria-label` so the glyph stays out of the
  accessible name.
- `ShortcutsOverlay` traps focus with `useFocusTrap` (`src/lib/focus-trap.ts`):
  focus moves into the dialog on open, Tab cycles within it, and focus is
  restored on close. Any new modal dialog should use the same hook.
- The detail toggles bind their own keys: `ToolDetail` owns `F`/`J`,
  `ShellDetail` owns `S` (toggling the native `<details>` through a ref so click
  and keyboard stay in sync). Allow/deny/back are bound once in `ApprovalDetail`.

## Tests

- Unit/UI tests are Vitest + Testing Library (`src/**/*.test.tsx`). The shared
  `src/test/setup.ts` mocks `matchMedia` (defaulting to desktop) and
  `scrollIntoView`; a test flips `matchMedia` to assert the mobile no-keyboard
  path. Cover both the desktop and mobile branches of any keyboard work.
- Tests cover the approval decision flow, request summarization, the broker
  bridge (the PWA's only request source, driven through a mocked bridge with raw
  protocol-v3 payloads), and offline behavior. Coverage gates enforce 95% lines/statements, 90% functions, and 80% branches. Line coverage keeps the create-repo default bar while branch coverage stays focused on meaningful UI paths.
- The production build must include the PWA manifest and service worker.
- E2E lives in its own project, `apps/web-e2e`, so a
  crate change re-runs it without re-running this project's targets. It must pass in both the `chromium-desktop` and
  `mobile-chrome` projects. The keyboard affordances must not appear or block
  interaction in the mobile viewport. The `broker-realtime.spec.ts` suite spawns
  the real broker, daemon, and plugin binaries and drives the full broker
  WebSocket path (allow/deny from the inbox and detail view, shell and tool
  calls); `pwa.spec.ts` and `theme.spec.ts` cover the offline shell and theming.

## Performance suite

Informational, never a gate. The suite:

- `just bench-web` / `just bundle-size` / `just render-cost` / `just heap` / `just lighthouse` run
  the PWA's parallel performance suite: Vitest micro-benchmarks of the pure decision/summarization
  surface (`apps/web/src/perf/*.bench.ts`), a deterministic gzip bundle-size report
  (`scripts/web-bundle-size.mjs`), a deterministic render-cost report
  (`scripts/web-render-cost.mjs`), a deterministic heap-footprint report
  (`scripts/web-heap.mjs`), and a Lighthouse runtime audit
  (`scripts/web-lighthouse.mjs`). The same `Performance` workflow `web` job runs all of them
  on PRs that affect web and posts its own sticky comment plus job summary; like the plugin
  suite it is informational, never a required check. Bundle size, render cost, and heap footprint
  are the deterministic, trustworthy deltas (the web counterpart of the plugin's cachegrind
  instruction counts and allocation tallies); the Vitest and Lighthouse numbers are absolute and
  noise-prone, so treat small deltas with caution.
- The PWA's **memory** layer is the web analogue of the Rust binaries' allocation reports (`just
  bench-allocs`): `just heap` runs the heap-footprint harness
  (`apps/web/src/perf/heap.perf.ts`), which measures memory the deterministic way — a structural
  walk of the retained object graph (object/array/string counts and string length), not
  `process.memoryUsage()`, so the base-vs-PR delta is reproducible. JS exposes no allocation hook
  the way a custom global allocator does in Rust, so it weighs what stays reachable: the per-inbox-card
  decision surface (charted against script length), plus an **inbox retention/leak check** —
  it folds a realistic broker event stream (snapshot → many `added` → resolve every one) through the
  real inbox reducers (`apps/web/src/inbox.ts`, the pure `applySnapshot`/`applyAdded`/`applyResolved`
  App uses) and asserts the retained graph returns to the empty baseline, since the PWA is the one
  long-lived web component and holds the inbox for the whole session. The harness file is kept out of
  the default `test`/coverage run by its `*.perf.ts` name and runs under its own
  `vitest.heap.config.ts`.

Layer details:

- **Micro-benchmarks** (`src/perf/*.bench.ts`, `nx run web:bench` /
  `just bench-web`): Vitest benchmarks of the pure, render-free decision surface
  in `approval.ts` (the `flaggedFragments`/`triggeredRules`/`requestHeadline`/
  `toolParamSummary` functions). Keep React, the DOM, and the
  network out of any timed loop — bench the same pure functions a render calls,
  not components. `*.bench.ts` is excluded from the `*.test.ts` run and coverage.
- **Bundle size** (`scripts/web-bundle-size.mjs` / `just bundle-size`): the
  deterministic, trustworthy delta layer — gzip + raw of the client JS/CSS under
  `.next/static`, aggregated by stable category (Turbopack content-hashes the
  filenames, so only category totals are comparable across builds).
- **Lighthouse** (`scripts/web-lighthouse.mjs` / `just lighthouse`): a runtime
  audit of the built app shell; wall-clock and noise-prone, so informational
  only. Needs Chrome on PATH (or `CHROME_PATH`).

## React Compiler

- The PWA enables **React Compiler** (`reactCompiler: true` in `apps/web/next.config.ts`,
  via `babel-plugin-react-compiler`): it auto-memoizes components/hooks at build time, so a
  re-render from state that does not touch a subtree skips it and each card's decision-surface
  work is cached across renders where its request is unchanged. The render-cost harness
  (`apps/web/src/perf/render-cost.perf.tsx`, run by `just render-cost`) is the render-side
  analogue of the plugin's instruction counts: it renders the real `<App>` over an inbox and
  counts how many decision-surface calls each interaction recomputes without the compiler vs
  with it (the deterministic delta). `@vitejs/plugin-react` transforms JSX with oxc, not Babel,
  so the harness wires the compiler through `@rolldown/plugin-babel` + `reactCompilerPreset`
  (`apps/web/vitest.render-cost.config.ts`, gated on `REACT_COMPILER=1`) to match the production
  build. The harness file is kept out of the default `test`/coverage run (its name is `*.perf.tsx`,
  not `*.test.tsx`).
  - **Do not hand-write `useMemo`/`useCallback`/`React.memo` for performance.** The compiler
    auto-memoizes every component and hook value at build time, so manual caching is redundant
    here — leave it out, and prefer plain derived values and inline handlers. (Reach for `useMemo`
    only on the rare occasion you need a *referentially stable value for correctness*, e.g. a
    dependency the compiler cannot see, not as an optimization.)
  - **A compiler bailout is a lint error.** The `lint-compiler` target (`nx run web:lint-compiler`,
    cached on the web `.ts`/`.tsx` sources) runs ESLint's React Compiler rules at error level, so a
    Rules-of-React violation that makes the compiler silently skip a component (a ref/state write
    during render, impurity, mutation, unsupported syntax, an incompatible library) fails the build.
    Fix the violation rather than papering over it with manual memoization. It runs in CI (`just
    check`) and the pre-push hook, never pre-commit.
