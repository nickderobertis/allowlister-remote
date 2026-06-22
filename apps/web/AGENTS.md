# AGENTS — `apps/web`

The Next.js PWA/server project. It owns the browser UI, the API routes, and the
browser/route/UI tests. Root-level guidance lives in the repo `CLAUDE.md`; this
file documents conventions specific to the web app.

## Approval UI shape

The single-page approval UI (`src/App.tsx`) has three states:

- **Inbox** — a list of pending approvals, each card opening a detail view or
  being allowed/denied inline.
- **Detail** — one approval, either a shell script (`ShellDetail`) or a tool
  call (`ToolDetail`), with allow/deny and view-specific controls.
- **Empty** — the resting state with no pending approvals.

`page.tsx` mounts `App`, which connects to the broker (the only request source)
using the URL from `/api/config` and renders whatever the broker relays. There is
no demo/offline data path; unit tests drive it through a mocked broker bridge
(`src/test/broker-fixtures.ts`).

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
- The detail toggles bind their own keys: `ToolDetail` owns `F`/`J`,
  `ShellDetail` owns `S` (toggling the native `<details>` through a ref so click
  and keyboard stay in sync). Allow/deny/back are bound once in `ApprovalDetail`.

## Tests

- Unit/UI tests are Vitest + Testing Library (`src/**/*.test.tsx`). The shared
  `src/test/setup.ts` mocks `matchMedia` (defaulting to desktop) and
  `scrollIntoView`; a test flips `matchMedia` to assert the mobile no-keyboard
  path. Cover both the desktop and mobile branches of any keyboard work.
- Coverage gates (root `CLAUDE.md`): 95% lines/statements, 90% functions, 80%
  branches.
- E2E (`e2e/`, Playwright) must pass in both the `chromium-desktop` and
  `mobile-chrome` projects. The keyboard affordances must not appear or block
  interaction in the mobile viewport. The `broker-realtime.spec.ts` suite spawns
  the real broker, daemon, and plugin binaries and drives the full broker
  WebSocket path (allow/deny from the inbox and detail view, shell and tool
  calls); `pwa.spec.ts` and `theme.spec.ts` cover the offline shell and theming.

## Performance suite

Informational, never a gate (root `CLAUDE.md`). Three layers mirror the Rust
plugin's bench suite:

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

The `Performance` workflow's `web` job runs all three on every PR and posts a
sticky comment plus a job summary.
