# Approval notifications: coverage and manual verification

The service worker raises an OS notification for each incoming approval request,
with **Approve** / **Deny** action buttons and a body previewing up to four of
the lines the operator must weigh (the flagged shell fragments, or a tool call's
arguments) with a `+N more` tail. Deciding from an action button routes the
verdict back through the broker exactly like an in-app decision; a `resolved`
event (decided here, in another tab, or at the terminal) clears the notification.

This is shown by the **live service worker while it is alive** — page open or
backgrounded but not yet evicted. True Web Push (waking a fully-closed device via
a push server with VAPID) is a separate, not-yet-built follow-up; see the
**Push delivery** gap in `CLAUDE.md`.

## Automated coverage

| Layer | What it proves | Where |
| --- | --- | --- |
| Unit (Vitest, real `sw.js` in a VM) | content build, four-line cap + overflow, actions/tag/data, snapshot-vs-added, focus suppression, resolve-closes, action→`sendDecision`, body→focus/open, socket-down fallback, boot permission request | `src/pwa/service-worker.test.ts`, `src/pwa/register-service-worker.test.tsx` |
| E2E (Playwright, real broker + daemon + plugin, real browser SW) | the live worker builds the right notification from a **real broker-delivered** request; Chrome accepts and round-trips it (actions + `data.requestId`); a foregrounded inbox suppresses the duplicate; the real `notificationclick` handler decides through the broker and unblocks the waiting plugin; a resolve closes the notification | `apps/web/e2e/notifications.spec.ts` |

Run the e2e (Chromium only — see below):

```
npx nx test-e2e web                                  # full suite
cd apps/web && npx playwright test notifications.spec.ts --project chromium-desktop
```

The notification spec sets `test.use({ channel: "chromium" })`: the Notifications
API needs **new headless** Chromium — old headless hard-denies the permission.

## The one hop only manual testing can cover

Playwright can neither read nor click a real OS notification, and cannot fire a
genuine `notificationclick`. The e2e synthesizes that event, so it proves our
handler and the broker transport — but **not** that Chrome itself populates
`event.action` from a literal button press. Verify that hop by hand once after
changing the notification options shape (`actions`, `data`) or the click handler:

1. **Serve the built PWA and a broker/daemon/plugin.** Easiest is to reuse the
   e2e binaries:
   ```
   npx nx build web
   node scripts/serve-web.mjs --dir apps/web/out --port 4183 &
   ALLOWLISTER_REMOTE_BROKER_ADDR=127.0.0.1:4188 target/debug/allowlister-remote-broker &
   ALLOWLISTER_REMOTE_DAEMON_SOCK=/tmp/alr.sock \
     ALLOWLISTER_REMOTE_BROKER_URL=ws://127.0.0.1:4188/ws/daemon \
     target/debug/allowlister-remote-daemon &
   ```
2. **Open the PWA** at `http://127.0.0.1:4183`, set the broker to
   `ws://127.0.0.1:4188`, and **grant the notification permission** when prompted.
3. **Background the tab** (switch to another window/app) — notifications are
   suppressed while the inbox is focused, by design.
4. **Open a request:**
   ```
   echo '{"subject":"shell","current_verdict":"ask","command":"git push --force","cwd":"/repo"}' \
     | target/debug/allowlister-remote-plugin --daemon-socket /tmp/alr.sock
   ```
5. **Confirm the OS notification appears** with the command preview and the
   **Approve** / **Deny** buttons.
6. **Click Approve.** The notification dismisses and the plugin process prints
   `{"verdict":"allow",...}` and exits — the decision travelled
   SW → broker → daemon → plugin. Repeat with **Deny** to confirm the deny path,
   and click the notification **body** to confirm it focuses the app.
