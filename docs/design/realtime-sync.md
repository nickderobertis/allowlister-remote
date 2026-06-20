# Design: realtime PWA ↔ plugin synchronization

Status: **proposal** · Branch: `claude/pwa-allowlister-communication-gnte6g`

This document proposes replacing the current poll-based approval transport with
a realtime, long-lived design suitable for approvals that stay open for hours or
days, while keeping delivery latency to roughly one round-trip. It is backed by
two runnable prototypes that validate the riskiest mechanics; see
[`prototypes/`](./prototypes/) and the [Validation](#validation) section.

## 1. Today's architecture

Three HTTP channels, all mediated by the Next.js app's in-memory store
(`apps/web/src/server/store.ts`); nothing talks peer-to-peer.

| Actor | Call | Endpoint |
| --- | --- | --- |
| Plugin → server | create request | `POST /api/plugin/requests` |
| Server → plugin | get decision | `GET /api/plugin/requests/{id}/decision` (150 ms poll) |
| Plugin → server | relay local decision | `POST /api/approval-requests/{id}/decision` |
| PWA → server | list pending | `GET /api/approval-requests` (2 s poll) |
| PWA → server | submit decision | `POST /api/approval-requests/{id}/decision` |

The store holds two maps (`requests`, `decisions`) on `globalThis`; a decision
recorded in either map is the single arbitration point, so whichever side
(local `/dev/tty` or web) writes first wins and the loser observes it on its
next poll (`crates/allowlister-remote-plugin/src/main.rs`,
`apps/web/src/App.tsx`).

### Why change it

* **Churn over long waits.** A single pending approval polled at 150 ms is
  ~24k requests/hour, ~575k/day. Approvals here have *no timeout by default*
  (`timeoutMs <= 0` ⇒ `expiresAt: null`), so a request can sit for days.
* **Latency floor.** 150 ms polling averages ~75 ms delivery; the browser's
  2 s poll is far worse.
* **Per-invocation connections.** The plugin is spawned **once per gated
  command** (see `CLAUDE.md`; the hot path is heavily optimized — static musl,
  `-no-pie`, dropping `ld.so`). Each process opening its own long-lived
  connection means a fresh TLS handshake + auth on exactly that hot path, and N
  concurrent connections for N concurrent gated commands.

## 2. Constraint: the plugin host is not reachable

In a full web deployment the plugin host sits behind NAT/firewalls with no
inbound connectivity. **The server can never dial the plugin.** This is already
satisfied by today's design and both transports below: every connection is
*client-initiated outbound* from the host, and the server only ever replies on a
connection the host already opened. So reachability is not the thing that forces
a new design — the per-invocation process model is.

## 3. Proposed architecture: broker + client-side daemon

```
   gated command (ephemeral, per invocation)
        │  owns stdin (payload), stdout (verdict), /dev/tty (local prompt)
   ┌────▼─────────┐   unix domain socket    ┌──────────────┐   1 outbound stream   ┌──────────┐
   │   plugin     │◀──────────────────────▶│    daemon     │◀────────────────────▶│  broker   │
   │ (Rust, short)│   REGISTER / DECISION   │ (Rust, long)  │  SSE down + POST up   │ (Next.js) │
   └──────────────┘                         └──────────────┘                       └────▲─────┘
                                                                                        │ SSE down
                                                                              ┌─────────┴────────┐
                                                                              │   PWA (browser)   │
                                                                              └───────────────────┘
```

The plugin process **cannot** be replaced by the daemon: it owns `stdin` (the
allowlister payload), `stdout` (the verdict it must return — the `write_response`
contract in `main.rs`), and `/dev/tty` (the local prompt, bound to *that*
process's controlling terminal). So responsibilities split by lifetime:

| Tier | Lifetime | Owns | Talks to |
| --- | --- | --- | --- |
| **Plugin** | seconds–hours, per command | stdin/stdout + `/dev/tty` prompt | local **daemon** over a unix socket |
| **Daemon** | days, one per host/user | the single upstream stream, auth/session, reconnect, request↔process routing | **broker** over one connection |
| **Broker** | always (the Next.js app) | request/decision state, fan-out, connection mgmt | daemons + PWAs |

The local-vs-web race is unchanged in spirit; it just moves. The plugin still
races its `/dev/tty` decision against a "remote" decision, but "remote" is now
the daemon over a microsecond-scale unix socket instead of HTTPS. A local win is
relayed by the daemon upstream (a `POST`) so the pending web card is dismissed.

## 4. Transport choice

**Plugin ↔ daemon: unix domain socket, line/JSON-framed.** Local IPC, no TLS, no
auth per message — the daemon already authenticated upstream. The socket *is*
the liveness signal: if the plugin is killed (Ctrl-C'd command), the socket
closes and the daemon withdraws the request upstream.

**Daemon/PWA ↔ broker: SSE down + plain POST up.**

* SSE is one-directional server→client push, which is all the downstream needs
  (decisions, cancellations). It runs over ordinary HTTP, works behind proxies,
  and `EventSource` has built-in auto-reconnect for the browser. The daemon uses
  the same `text/event-stream` endpoint.
* Upstream writes (create-request, relay-local-decision) are ordinary `POST`s —
  no persistent client→server channel needed.
* **Not WebSockets.** The traffic is request/response plus notifications, not a
  high-frequency bidirectional stream, and Next.js App Router route handlers
  can't perform the WS upgrade without a custom server. WebSockets stay an
  option *only* for the daemon's upstream if its multiplex volume ever warrants
  a dedicated socket service; the PWA never needs them.
* **Long-poll is the fallback.** A hanging `GET .../decision` capped at ~25 s
  gives one-RTT delivery with zero new protocol, for environments where SSE is
  blocked. It degrades to ordinary polling if the cap is lowered.

### Why long waits are safe

The key inversion: **the logical wait is days, but no single connection is held
for days.** Long-poll hangs are capped at ~25 s and re-issued; SSE connections
are kept alive with heartbeats and resumed on drop. Short physical connections
are *more* robust across hostile intermediaries, not less.

Keepalive strategy:

1. **Cap every hang** (~25 s long-poll, ~15–25 s heartbeat) under the shortest
   proxy/LB idle timeout (commonly 30–60 s).
2. **SSE heartbeats**: emit `:ping\n\n` every ~15 s; set `Cache-Control:
   no-cache` and `X-Accel-Buffering: no` to defeat proxy buffering.
3. **Lossless resume**: every event carries a monotonic id; on reconnect the
   client sends `Last-Event-ID` (browser does this automatically) / a `?since=`
   cursor, and the broker replays everything after it. Over day-long sessions
   reconnects are routine — they must not drop a decision.
4. **Daemon reconnect/backoff**: the request `id` is the durable handle, so
   re-subscribing after a drop just resumes.
5. **Runtime**: these handlers must run on the **Node** runtime as
   streaming/dynamic responses (`export const runtime = "nodejs"`,
   `export const dynamic = "force-dynamic"`) — not edge, not static.

## 5. Server-side changes (the store)

`store.ts` is currently pure data maps. It grows a small notification primitive:

* an `EventEmitter` (or a set of waiter promises) plus a monotonic, replayable
  event log keyed by a sequence number;
* `enqueuePluginRequest` and `decideRequest` emit `added` / `decided` events
  after mutating state;
* a new `waitForDecision(id, deadlineMs)` that resolves on a `decided` event or
  the deadline — this replaces the plugin's 150 ms poll loop with a single
  hanging request;
* `eventsSince(seq)` for SSE replay.

Endpoints:

* `GET /api/plugin/requests/{id}/decision` → hang via `waitForDecision`, return
  `200 {verdict,reason}` or `202 {status:"pending"}` at the cap. **Wire shape
  unchanged** — only the timing changes, so the existing
  `interpret_decision`/202-pending contract in the plugin still holds.
* `GET /api/events` (new) → SSE `ReadableStream`: replay `eventsSince(lastId)`,
  then live events, with heartbeats.

Session ownership for fan-out: the create `POST` is authenticated as a daemon
session; the broker tags each request with the owning session, and only pushes a
request's `decided`/`cancelled` events down that session's stream. One stream
correctly carries all of one host's in-flight requests.

## 6. Client-side changes

* **PWA**: swap `App.tsx`'s 2 s `setInterval` for an `EventSource` on
  `/api/events`; keep `POST .../decision` as-is. The `DemoApprovalApi` path is
  untouched.
* **Plugin**: replace the network loop in `main.rs` with a unix-socket
  handshake to the daemon (register the request, await a `DECISION`, race
  `/dev/tty` locally). The pure helpers in `lib.rs`
  (`triage`, `build_create_body`, `interpret_decision`, `parse_local_input`)
  are reused unchanged. A direct-HTTPS fallback (today's long-poll) stays for
  when no daemon is reachable.
* **Daemon** (new, Rust): one persistent SSE subscription to the broker; a unix
  listener fanning short-lived plugin connections; a registry mapping
  `request_id → waiting plugin connection`; reconnect/backoff/heartbeat handling
  in one place.

## 7. Failure modes (decide explicitly)

| Situation | Behavior |
| --- | --- |
| Daemon not running | Plugin auto-spawns it (agent-style), else falls back to direct HTTPS long-poll. |
| Daemon crashes mid-wait | Plugin detects socket close; reconnect to a restarted daemon, else direct fallback, else **fail-closed** (`ask`/deny). |
| Plugin killed / command Ctrl-C'd | Socket close ⇒ daemon **withdraws** the request upstream so the PWA stops showing a stale prompt (today it lingers until expiry). |
| Broker unreachable | Daemon retries with backoff; plugin honors `--timeout-ms` if set, else waits, surfacing status to `/dev/tty`. |

Recommended default: **fail-closed** when no decision channel can be
established, consistent with an approval tool.

## 8. The multi-instance caveat

This assumes a **single broker process**, which `globalThis.__allowlisterRemoteState`
already requires. Multiple broker instances break in-process fan-out (a waiter
or SSE on instance A won't see a decision posted to instance B). Crossing that
line means adding a shared pub/sub (e.g. Redis) and durable state — the same
items `CLAUDE.md` lists as intentionally out of scope for this scaffold. The
daemon does not move that boundary; it just makes it the obvious next milestone
if the broker scales horizontally.

## 9. Phased rollout

1. **Store notification primitive + long-poll** the plugin decision endpoint
   (biggest, lowest-risk win; wire shape unchanged). *(broker-proto validated)*
2. **SSE `/api/events` + PWA `EventSource`** with heartbeats and `Last-Event-ID`
   resume. *(broker-proto validated)*
3. **Daemon**: unix-socket multiplexing + single upstream subscription +
   request routing; plugin talks to the daemon with direct-HTTPS fallback.
   *(daemon-proto validated)*
4. **Session ownership / fan-out scoping** and explicit failure-mode policy.
5. (If needed) shared pub/sub for horizontal scale.

## 10. Validation

Both prototypes are runnable and assert their claims; see
[`prototypes/README.md`](./prototypes/README.md). Measured results:

**`broker-proto.mjs`** (transport mechanics, plain Node):

```
PASS  long-poll hangs while pending
PASS  long-poll released with the decision
PASS  delivery latency is ~one RTT  (5ms)
PASS  delivery faster than the old 150ms poll  (5ms)
PASS  SSE pushed the decided event
PASS  Last-Event-ID reconnect replays the missed event
PASS  SSE emits heartbeats
ALL PASS — 7/7
```

**`daemon-proto.rs`** (client-side multiplexing, std-only Rust, real unix socket):

```
PASS  all 4 plugins resolved over one socket
PASS  r1 routed to its upstream verdict
PASS  r2 routed to its upstream verdict
PASS  r3 routed despite out-of-order delivery
PASS  l1 won the local-terminal race
PASS  daemon relayed l1's local decision upstream
PASS  daemon did NOT relay remote-decided requests
ALL PASS
```

Together these de-risk: one-RTT delivery without polling churn (≈5 ms vs ≥75 ms
average), SSE push + lossless reconnect for day-long sessions, and a single
daemon multiplexing many ephemeral plugins with correct id-routing and the
local-first race relayed upstream. What they intentionally do **not** cover —
deferred to implementation — is real auth/session handshaking, the daemon's
production reconnect/backoff, and Next.js runtime wiring.
