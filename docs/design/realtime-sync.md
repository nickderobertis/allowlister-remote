# Design: realtime PWA ↔ plugin synchronization

Status: **shipped** — the broker is now the *only* approval transport. The
poll-based HTTP path described in §1 below has been removed entirely (no
fallback); §1 is retained as historical context for why the broker exists.

Replace the poll-based approval transport with a realtime design built around a
dedicated Rust **connection broker**, suitable for approvals that stay open for
hours or days while keeping delivery latency to roughly one round-trip. The
broker and the host **daemon** are written in Rust (axum + tokio) for the
highest-performance hot path; the existing Next.js app keeps serving the PWA.

Backed by runnable code and tests — see [Implementation status](#implementation-status)
and the early-stage [`prototypes/`](./prototypes/).

## 1. The original (now-removed) architecture

> Historical: this poll-based HTTP transport and its in-memory store have been
> deleted; the broker design in the following sections is what ships today.

Three HTTP channels mediated by the Next.js app's in-memory store
(`apps/web/src/server/store.ts`); nothing talked peer-to-peer.

| Actor | Call | Endpoint |
| --- | --- | --- |
| Plugin → server | create request | `POST /api/plugin/requests` |
| Server → plugin | get decision | `GET /api/plugin/requests/{id}/decision` (150 ms poll) |
| Plugin → server | relay local decision | `POST /api/approval-requests/{id}/decision` |
| PWA → server | list pending | `GET /api/approval-requests` (2 s poll) |
| PWA → server | submit decision | `POST /api/approval-requests/{id}/decision` |

### Why change it

* **Churn over long waits.** Approvals have *no timeout* — a request waits
  indefinitely and can sit for days. At a 150 ms poll that is ~24k
  requests/hour, ~575k/day, for a single approval.
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

1. **Heartbeats.** The broker sends a WebSocket Ping to every connection on a
   configurable interval (`ALLOWLISTER_REMOTE_BROKER_PING_MS`, default 20 s);
   clients auto-pong, keeping idle connections under typical proxy/LB idle
   timeouts (30–60 s). *(implemented + tested)*
2. **Auto-reconnect.** The daemon reconnects to the broker with capped backoff;
   the request `id` is the durable handle. The browser's service worker
   reconnects the same way and re-`subscribe`s on open. *(implemented + tested)*
3. **Lossless resume.** On reconnect the daemon **re-announces** its still-pending
   requests (idempotent on the broker — only ownership is refreshed for a request
   it still has; a restarted broker re-learns and re-broadcasts it) and the PWA
   re-`subscribe`s for a fresh snapshot, so a decision that landed during a gap is
   not missed. *(implemented + tested: a request survives a full broker restart.)*
   A monotonic per-connection event cursor is a later refinement if snapshots
   become large.
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
| Daemon disconnects from broker | Broker withdraws that daemon's pending requests so no PWA shows a dead prompt; on a transient drop the daemon reconnects and **re-announces**, restoring the cards. *(implemented + tested)* |
| Broker restarts mid-wait | Daemon reconnects (backoff) and re-announces still-pending requests to the fresh broker; a new PWA learns them and can decide — the original plugin, still waiting, gets the decision. *(implemented + tested)* |
| Broker unreachable | Daemon retries with capped backoff; the plugin waits indefinitely. |

Recommended default: **fail-closed** when no decision channel can be established.

## 7. Many clients on one broker (decided scope: single broker, in-memory)

This repo deliberately targets **one broker process with in-memory routing
state** — no horizontal scaling, no external bus. Within that, the broker
fully supports **many concurrent daemons and many concurrent PWAs at once**:

* Every subscribed PWA receives **every** daemon's requests (snapshot on
  subscribe, then live `added`/`resolved`).
* **Any** PWA can decide **any** daemon's request; the broker routes the
  decision to the one daemon that owns it (and only that one) and dismisses the
  card on every PWA.
* A daemon disconnect withdraws only its own requests.

This is the core mediation guarantee and is covered end-to-end at three levels
(see §8): the broker integration tests, the process-level e2e with multiple real
daemons and PWAs, and the browser e2e with multiple PWA clients.

Out of scope by decision: running more than one broker instance (which would need
a shared pub/sub for cross-instance fan-out) and per-user request scoping (today,
consistent with the existing store and `CLAUDE.md`'s "no auth", all PWAs see all
pending requests).

## 8. Implementation status

New Rust workspace crates (kept separate so they never pull async runtimes into
the size-optimized plugin binary):

* **`crates/allowlister-remote-broker`** — axum WebSocket mediator. `Broker`
  holds the routing state; `app()` builds the router with `/ws/daemon`,
  `/ws/pwa`, `/healthz`. Idempotent `create` (for re-announce) and a per-connection
  heartbeat Ping. **Done + tested.** `tests/mediation.rs` (7 tests, real WS
  clients): multi-PWA fan-out, web-decision routing back to the owning daemon,
  local-terminal relay without echo, late-subscribe snapshot, daemon-disconnect
  withdrawal, **many-daemons-and-PWAs cross fan-out + owner-routing**, and the
  heartbeat ping.
* **`crates/allowlister-remote-daemon`** — tokio daemon: one supervised broker
  WebSocket (**reconnect with backoff + re-announce of pending requests**) and a
  unix-socket listener multiplexing plugins; `serve(Config)`. Dials `ws://` and
  **`wss://`** (system trust or a custom CA via `ALLOWLISTER_REMOTE_BROKER_CA`).
  **Done + tested.** `tests/end_to_end.rs` (3 tests): decision down, local relay
  up, plugin-exit withdrawal. `tests/tls.rs`: a real `wss://` handshake with a
  self-signed CA.

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

* **Packaging** (`packages/**`, `scripts/`, `publish.yml`) — the daemon binary
  ships in each per-platform npm package next to the plugin; `install.mjs` links
  both so the plugin's sibling lookup finds the daemon; release staging and the
  publish workflow build/stamp/upload it from the git tag. **Done** (install test
  + post-publish smokes; cross-target builds run in CI).
* **End-to-end** — three complementary levels exercise the real artifacts:
  * `crates/allowlister-remote-broker/tests/mediation.rs` — multi-daemon /
    multi-PWA fan-out and owner-routing at the mediation layer.
  * `crates/allowlister-remote-e2e` (process-level, 7 tests): spawns the real
    **broker + daemon + plugin binaries**. Full chain, plugin **auto-starting the
    real daemon**, **multiple real daemons + multiple PWAs together**, a request
    **surviving a broker restart**, and per-binary smokes.
  * `apps/web/e2e/broker-realtime.spec.ts` (Playwright, desktop + mobile): real
    broker + daemon + plugin **and the real service worker / PWA** in Chromium —
    single-PWA decide-and-release and **two PWA clients both seeing and resolving**
    a request. Broker URL supplied at runtime via `/api/config`. **Done.**

Remaining (all deliberately out of scope for this repo — see §7):

* Running more than one broker instance (needs a shared pub/sub) and per-user
  request scoping / auth.

## 9. Phased rollout

1. ✅ Broker mediation core (WS, routing, fan-out, withdrawal).
2. ✅ Daemon (unix multiplexing + single upstream + plugin routing).
3. ✅ Plugin daemon-client + auto-start (HTTP fallback retained).
4. ✅ Service worker + page wiring (live sync alongside the poll fallback).
5. ✅ End-to-end coverage: process-level (real binaries) + Playwright (real PWA/SW).
6. ✅ Heartbeat + reconnect/re-announce, `wss://`, multi-client coverage, packaging.
7. Out of scope: multi-broker pub/sub and per-user session scoping.

## 10. Early prototypes

Before the crates above, two throwaway prototypes in [`prototypes/`](./prototypes/)
validated the core mechanics (long-poll release latency, SSE push + Last-Event-ID
resume; unix-socket multiplexing + id-routing + local-first relay). They informed
the design and the transport decision; the broker/daemon crates now supersede
them as the real, tested implementation.
