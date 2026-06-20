# Design: realtime PWA ↔ plugin synchronization

Status: **in progress** · Branch: `claude/pwa-allowlister-communication-gnte6g`

Replace the poll-based approval transport with a realtime design built around a
dedicated Rust **connection broker**, suitable for approvals that stay open for
hours or days while keeping delivery latency to roughly one round-trip. The
broker and the host **daemon** are written in Rust (axum + tokio) for the
highest-performance hot path; the existing Next.js app keeps serving the PWA.

Backed by runnable code and tests — see [Implementation status](#implementation-status)
and the early-stage [`prototypes/`](./prototypes/).

## 1. Today's architecture

Three HTTP channels mediated by the Next.js app's in-memory store
(`apps/web/src/server/store.ts`); nothing talks peer-to-peer.

| Actor | Call | Endpoint |
| --- | --- | --- |
| Plugin → server | create request | `POST /api/plugin/requests` |
| Server → plugin | get decision | `GET /api/plugin/requests/{id}/decision` (150 ms poll) |
| Plugin → server | relay local decision | `POST /api/approval-requests/{id}/decision` |
| PWA → server | list pending | `GET /api/approval-requests` (2 s poll) |
| PWA → server | submit decision | `POST /api/approval-requests/{id}/decision` |

### Why change it

* **Churn over long waits.** Approvals have *no timeout by default*
  (`timeoutMs <= 0` ⇒ `expiresAt: null`), so a request can sit for days. At a
  150 ms poll that is ~24k requests/hour, ~575k/day, for a single approval.
* **Latency floor.** 150 ms polling averages ~75 ms delivery; the browser's 2 s
  poll is far worse.
* **Per-invocation connections.** The plugin is spawned **once per gated
  command** (`CLAUDE.md`; the hot path is heavily optimized). A short-lived
  process is the wrong place to hold an hours-long connection — a fresh TLS/auth
  handshake on every gated command, and N connections for N concurrent commands.

## 2. Constraint: the plugin host is not reachable

In a full web deployment the plugin host sits behind NAT/firewalls with no
inbound connectivity. **The server can never dial the host.** Every connection
is therefore *client-initiated outbound*; the server only ever replies on a
connection a client already opened. This holds for both edges below.

## 3. Architecture: a dedicated broker mediating daemons ↔ PWAs

The Rust broker's sole job is to **mediate connections** between many instances
of two clients. It is not the web UI and does not replace Next.js.

```
   gated command (ephemeral, per invocation)
        │  owns stdin (payload), stdout (verdict), /dev/tty (local prompt)
   ┌────▼─────────┐   unix domain socket    ┌──────────────┐   1 WebSocket (out)   ┌──────────────┐
   │   plugin     │◀──────────────────────▶│    daemon     │◀────────────────────▶│              │
   │ (Rust, short)│  create / decision/ack  │ (Rust, tokio) │   /ws/daemon          │  broker      │
   └──────────────┘                         └──────────────┘                       │ (Rust, axum) │
                                                                                   │              │
   ┌──────────────┐                         ┌──────────────┐   1 WebSocket (out)   │  in-memory   │
   │  PWA page(s) │◀──postMessage──────────▶│ service      │◀────────────────────▶│  routing     │
   │ (React UI)   │                         │ worker       │   /ws/pwa             │  only        │
   └──────────────┘                         └──────────────┘                       └──────────────┘
```

Responsibilities split by lifetime — the plugin process **cannot** be replaced
by the daemon because it owns `stdin`/`stdout` (the `write_response` contract in
`main.rs`) and `/dev/tty` (the local prompt, bound to that process's terminal):

| Tier | Lifetime | Owns | Talks to |
| --- | --- | --- | --- |
| **Plugin** | seconds–hours, per command | stdin/stdout + `/dev/tty` prompt | local **daemon** over a unix socket |
| **Daemon** | days, one per host/user | the single upstream WebSocket, request↔plugin routing | **broker** at `/ws/daemon` |
| **Service worker** | the browser session | the single upstream WebSocket, page fan-out via `postMessage` | **broker** at `/ws/pwa` |
| **Broker** | always (new Rust service) | ephemeral routing state: which daemon owns which pending request, the set of subscribed PWAs | daemons + service workers |

The local-vs-web race is unchanged in spirit; it moves to the daemon. The plugin
races its `/dev/tty` decision against a decision relayed from the daemon (over a
microsecond unix socket, not HTTPS). A local win is relayed by the daemon
upstream so the pending web card is dismissed; the broker resolves whichever
side is first and is idempotent for the loser.

## 4. Transport: WebSockets on both broker edges

A dedicated axum broker changes the earlier transport call. The first draft of
this doc recommended SSE-down + POST-up *because the broker was a Next.js route
handler, which cannot perform a WebSocket upgrade.* With a standalone axum
service that blocker is gone, and the mediation is genuinely **bidirectional and
multi-instance**, so **WebSocket is the right, highest-performance choice for
both edges** (service worker ↔ broker and daemon ↔ broker). axum has first-class
WebSocket support; tokio-tungstenite is the daemon's client.

* **Plugin ↔ daemon: unix domain socket, newline-delimited JSON.** Local IPC, no
  TLS or per-message auth. The socket *is* the liveness signal: if the plugin is
  killed (Ctrl-C'd command) the socket closes and the daemon withdraws the
  request upstream.
* **Long-poll fallback** stays available for the plugin's legacy direct-to-Next
  path when no daemon/broker is reachable (today's behavior, unchanged).

### Wire protocol (broker)

daemon → broker: `create {request:{id,…}}`, `decision {requestId,verdict,reason}`
(local relay), `withdraw {requestId}`.
broker → daemon: `decision {requestId,verdict,reason}` (web decision routed to owner).
PWA → broker: `subscribe`, `decision {requestId,verdict,reason}`.
broker → PWA: `snapshot {requests:[…]}`, `added {request}`, `resolved {requestId}`.

### Wire protocol (plugin ↔ daemon)

plugin → daemon: `create {payload:{…allowlister body…}}` (daemon assigns the id),
`decision {verdict,reason}` (local terminal).
daemon → plugin: `decision {verdict,reason}` (web), `ack` (local relay forwarded).

## 5. Surviving hours/days

The key inversion: **the logical wait is days, but no single message exchange is
held for days.** Connections are kept alive deliberately, and resumed losslessly
when they drop.

1. **Heartbeats.** WebSocket Ping/Pong (or an app-level keepalive) every ~15–25 s
   keeps idle connections under typical proxy/LB idle timeouts (30–60 s).
2. **Auto-reconnect.** The daemon reconnects to the broker with backoff; the
   request `id` is the durable handle, so re-subscription resumes. The browser's
   service worker reconnects the same way.
3. **Lossless resume.** On reconnect the daemon re-announces its still-pending
   requests and the PWA re-`subscribe`s for a fresh snapshot, so a decision that
   landed during a gap is not missed. (A monotonic per-connection event cursor is
   a later refinement if snapshots become large.)
4. **Service-worker lifetime.** Browsers may evict an idle service worker; an
   open WebSocket keeps it alive while connected, and reconnect-on-activate
   re-establishes it. Delivery while the app is fully closed is **out of scope**
   (it needs Web Push / VAPID, which `CLAUDE.md` lists as excluded).

## 6. Failure modes

| Situation | Behavior |
| --- | --- |
| No daemon running | Plugin **auto-starts** it, else falls back to direct HTTPS long-poll. |
| Daemon crashes mid-wait | Plugin detects socket close; reconnect to a restarted daemon, else direct fallback, else **fail-closed** (`ask`/deny). |
| Plugin killed / command Ctrl-C'd | Socket close ⇒ daemon **withdraws** the request upstream so the PWA stops showing a stale prompt. *(implemented + tested)* |
| Daemon disconnects from broker | Broker withdraws all that daemon's pending requests so no PWA is left with a dead prompt. *(implemented + tested)* |
| Broker unreachable | Daemon retries with backoff; plugin honors `--timeout-ms` if set, else waits. |

Recommended default: **fail-closed** when no decision channel can be established.

## 7. Multi-instance / multi-tenant

The broker holds only in-memory routing state, so a single broker process is
assumed. Horizontal scale needs a shared pub/sub (e.g. Redis) for cross-instance
fan-out. Per-user request scoping (so a PWA only sees its own host's requests)
also lands here; today, consistent with the existing store and `CLAUDE.md`'s
"no auth", all subscribed PWAs see all pending requests. Both are deferred and
called out as the next milestone, not silently assumed away.

## 8. Implementation status

New Rust workspace crates (kept separate so they never pull async runtimes into
the size-optimized plugin binary):

* **`crates/allowlister-remote-broker`** — axum WebSocket mediator. `Broker`
  holds the routing state; `app()` builds the router with `/ws/daemon`,
  `/ws/pwa`, `/healthz`. **Done + tested.**
  `tests/mediation.rs` (4 tests, real WS clients): fan-out to multiple PWAs,
  web-decision routing back to the owning daemon, local-terminal relay without
  echo, late-subscribe snapshot, and daemon-disconnect withdrawal.
* **`crates/allowlister-remote-daemon`** — tokio daemon: one broker WebSocket +
  a unix-socket listener multiplexing plugins; `serve(Config)`. **Done + tested.**
  `tests/end_to_end.rs` (3 tests, real broker + daemon + fake plugin + fake PWA):
  web decision down to the plugin, local-terminal decision up dismissing web,
  and plugin-exit withdrawal.

* **Plugin** (`crates/allowlister-remote-plugin`) — daemon mode: a unix-socket
  client that auto-starts the daemon if none is listening (detached, own process
  group, sibling-binary resolution), races the `/dev/tty` prompt against the
  relayed decision, and falls back to the existing HTTP path. Opt-in via
  `--use-daemon` / `--broker-url` / `--daemon-socket`. **Done + tested.**
* **Service worker + page** (`apps/web`) — `public/sw.js` holds one WebSocket to
  `/ws/pwa`, subscribes, relays broker events to all clients via `postMessage`,
  and reconnects with capped backoff; `src/pwa/broker-bridge.ts` is the page-side
  bridge; `App.tsx` adds a live-sync effect alongside the 2 s poll fallback,
  gated on `NEXT_PUBLIC_ALLOWLISTER_BROKER_URL`. **Done + tested** (SW bridge and
  page bridge unit-tested; the live `App` wiring is e2e-scoped).

* **End-to-end** — two complementary suites exercise the real built artifacts:
  * `crates/allowlister-remote-e2e` (process-level, 5 tests): spawns the real
    **broker + daemon + plugin binaries** together; a WS client stands in for the
    PWA. Covers the full chain, the plugin **auto-starting the real daemon**, and
    per-binary smokes (broker `/healthz`, plugin `--version`/static-allow).
  * `apps/web/e2e/broker-realtime.spec.ts` (Playwright, desktop + mobile): the
    real broker + daemon + plugin binaries **and the real service worker / PWA**
    in Chromium. A request opened by the plugin reaches the inbox over the broker
    and an Allow click routes the decision SW → broker → daemon → plugin. The
    broker URL is supplied at runtime via `/api/config`. **Done.**

Remaining:

* **Packaging**: ship the daemon binary alongside the plugin in the per-platform
  npm packages; broker deployment + `wss://` TLS.
* **Heartbeat/reconnect refinements**, per-user session scoping, and the
  multi-instance pub/sub (Redis) for horizontal broker scale.

## 9. Phased rollout

1. ✅ Broker mediation core (WS, routing, fan-out, withdrawal).
2. ✅ Daemon (unix multiplexing + single upstream + plugin routing).
3. ✅ Plugin daemon-client + auto-start (HTTP fallback retained).
4. ✅ Service worker + page wiring (live sync alongside the poll fallback).
5. ✅ End-to-end coverage: process-level (real binaries) + Playwright (real PWA/SW).
6. ⏳ Heartbeat/reconnect refinements, packaging, `wss://`, session scoping.
7. (If needed) shared pub/sub for horizontal scale.

## 10. Early prototypes

Before the crates above, two throwaway prototypes in [`prototypes/`](./prototypes/)
validated the core mechanics (long-poll release latency, SSE push + Last-Event-ID
resume; unix-socket multiplexing + id-routing + local-first relay). They informed
the design and the transport decision; the broker/daemon crates now supersede
them as the real, tested implementation.
