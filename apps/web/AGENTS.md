# AGENTS — `apps/web`

The Next.js PWA project — a **fully static export** (`output: "export"`, no
server of its own). It owns the browser UI and the browser/route/UI tests.
Root-level guidance lives in the repo `CLAUDE.md`; this file documents conventions
specific to the web app.

## Project boundaries

It owns the UI and service-worker unit tests and the visual-docs capture
(`web:capture`). It has no edge to any crate. It is its own npm workspace package
(`apps/web/package.json` declares every dependency the app uses); the root
`package.json` keeps only repo tooling (Nx, Biome, knip, the root scripts'
Lighthouse deps, `yaml`), and `web-e2e` declares its own.

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
  protocol-v3 payloads), and offline behavior. The coverage gates in
  `vitest.config.ts` keep line coverage at the create-repo default bar while
  branch coverage stays focused on meaningful UI paths.
- The production build must include the PWA manifest and service worker.
- The keyboard affordances must not appear or block interaction in the mobile
  viewport.

## Performance suite

Informational, never a required check; the `Performance` workflow's `web` job runs
every layer on PRs that affect web and posts a sticky comment plus a job summary.
Bundle size, render cost, and heap footprint are the deterministic deltas; the
Vitest and Lighthouse numbers are absolute and noise-prone, so treat small deltas
with caution.

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
- **Render cost** (`src/perf/render-cost.perf.tsx` / `just render-cost`): counts the
  decision-surface calls each interaction recomputes without vs with React Compiler.
- **Heap** (`src/perf/heap.perf.ts` / `just heap`): weighs the retained object graph
  structurally, never `process.memoryUsage()`, so the delta is reproducible. Its
  inbox retention check folds a broker event stream through the real `src/inbox.ts`
  reducers and asserts the graph returns to the empty baseline.
- **Lighthouse** (`scripts/web-lighthouse.mjs` / `just lighthouse`): a runtime
  audit of the built app shell; wall-clock and noise-prone, so informational
  only. Needs Chrome on PATH (or `CHROME_PATH`).

`*.perf.ts(x)` harnesses stay out of the default `test`/coverage run.

## React Compiler

`reactCompiler: true` (`next.config.ts`) auto-memoizes every component and hook at
build time. The render-cost harness must wire the compiler the same way
(`vitest.render-cost.config.ts`, gated on `REACT_COMPILER=1`) to match the
production build.

- **Do not hand-write `useMemo`/`useCallback`/`React.memo` for performance.** Prefer
  plain derived values and inline handlers; reach for `useMemo` only when a
  referentially stable value is needed for correctness.
- **A compiler bailout is a lint error.** `nx run web:lint-compiler` runs ESLint's
  React Compiler rules at error level; fix the Rules-of-React violation rather than
  papering over it with manual memoization. It runs in CI (`just check`) and the
  pre-push hook, never pre-commit.
