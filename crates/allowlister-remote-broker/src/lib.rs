//! The allowlister-remote **broker**: a stateless-by-design connection mediator.
//!
//! Its only job is to relay approval traffic between two kinds of clients, each
//! of which may have many concurrent instances:
//!
//! * **daemons** — one long-lived process per host, multiplexing that host's
//!   ephemeral plugin processes (see `crates/allowlister-remote-daemon`). A
//!   daemon *owns* the requests it opens.
//! * **PWAs** — the service worker in the Next.js app holds one WebSocket per
//!   browser instance and renders/decides requests.
//!
//! Both edges are WebSockets because the mediation is genuinely bidirectional
//! and multi-instance. The broker keeps only ephemeral routing state in memory
//! (which daemon owns which pending request, and the set of subscribed PWAs);
//! durable persistence and auth are intentionally out of scope (see `CLAUDE.md`).
//!
//! ## Wire protocol (JSON text frames)
//!
//! daemon → broker:
//! * `{"type":"create","request":{"id":…, …}}` — open a request this daemon owns.
//! * `{"type":"decision","requestId":…,"verdict":"allow|deny","reason":…}` — a
//!   local-terminal decision, relayed so the web prompt is dismissed.
//! * `{"type":"withdraw","requestId":…}` — the plugin exited; cancel the request.
//!
//! broker → daemon:
//! * `{"type":"decision","requestId":…,"verdict":…,"reason":…}` — a web decision
//!   routed back to the owning daemon.
//!
//! PWA → broker:
//! * `{"type":"subscribe"}` — receive a snapshot of pending requests, then live updates.
//! * `{"type":"decision","requestId":…,"verdict":…,"reason":…}` — a web decision.
//!
//! broker → PWA:
//! * `{"type":"snapshot","requests":[…]}` — current pending set (on subscribe).
//! * `{"type":"added","request":{…}}` — a new pending request.
//! * `{"type":"resolved","requestId":…}` — a request was decided/withdrawn.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

/// Which side of the mediation a connection is on. Determines which messages it
/// may send and how a decision it submits is routed.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Role {
    Daemon,
    Pwa,
}

/// A pending request plus the daemon connection that owns it (so a web decision
/// can be routed back to the host that is waiting).
struct Pending {
    request: Value,
    owner: u64,
}

#[derive(Default)]
struct Inner {
    requests: HashMap<String, Pending>,
    daemons: HashMap<u64, UnboundedSender<String>>,
    pwas: HashMap<u64, UnboundedSender<String>>,
}

/// The shared mediation state. Cloneable as `SharedBroker` (an `Arc`).
pub struct Broker {
    inner: Mutex<Inner>,
    next_conn: AtomicU64,
    /// Keepalive ping interval, in milliseconds, read once here at construction
    /// rather than per connection — so the value is fixed for the broker's life
    /// and a test (or anything else) can inject it without a process-global env
    /// mutation that would race connections opened concurrently.
    ping_ms: u64,
}

/// Default keepalive ping interval when the environment does not override it.
const DEFAULT_PING_MS: u64 = 20_000;

impl Default for Broker {
    /// Production construction: read the keepalive interval from
    /// `ALLOWLISTER_REMOTE_BROKER_PING_MS` once, at startup.
    fn default() -> Self {
        let ping_ms = std::env::var("ALLOWLISTER_REMOTE_BROKER_PING_MS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(DEFAULT_PING_MS);
        Self::with_ping_ms(ping_ms)
    }
}

impl Broker {
    /// Construct a broker with an explicit keepalive ping interval. Lets a test
    /// drive a short, observable interval without mutating the process-global
    /// environment, which would leak into the brokers other parallel tests run.
    pub fn with_ping_ms(ping_ms: u64) -> Self {
        Self {
            inner: Mutex::default(),
            next_conn: AtomicU64::new(0),
            ping_ms,
        }
    }
}

pub type SharedBroker = Arc<Broker>;

/// The dispatch key of an inbound frame: its `type`, or `""` when absent. Pure;
/// the first thing `on_message` does to route a frame.
pub fn message_kind(message: &Value) -> &str {
    message.get("type").and_then(Value::as_str).unwrap_or("")
}

/// Wire envelope announcing a new pending request to PWAs. Pure: the
/// per-`create` serialization the broker fans out to every subscriber.
pub fn added_message(request: &Value) -> String {
    json!({ "type": "added", "request": request }).to_string()
}

/// Wire envelope telling PWAs to dismiss a resolved request. Pure.
pub fn resolved_message(id: &str) -> String {
    json!({ "type": "resolved", "requestId": id }).to_string()
}

/// Wire envelope routing a web decision back to the owning daemon. Pure.
pub fn decision_message(id: &str, verdict: &str, reason: &str) -> String {
    json!({ "type": "decision", "requestId": id, "verdict": verdict, "reason": reason }).to_string()
}

/// Wire envelope of the current pending set sent to a newly-subscribed PWA.
/// Pure: the snapshot serialization, which grows with the pending count.
pub fn snapshot_message(requests: &[&Value]) -> String {
    json!({ "type": "snapshot", "requests": requests }).to_string()
}

/// Build the axum router. Split out from `main` so integration tests can serve
/// the same app on an ephemeral port.
pub fn app(broker: SharedBroker) -> Router {
    Router::new()
        .route("/ws/daemon", get(daemon_ws))
        .route("/ws/pwa", get(pwa_ws))
        .route("/healthz", get(|| async { "ok" }))
        .with_state(broker)
}

async fn daemon_ws(ws: WebSocketUpgrade, State(broker): State<SharedBroker>) -> Response {
    ws.on_upgrade(move |socket| serve_connection(socket, broker, Role::Daemon))
}

async fn pwa_ws(ws: WebSocketUpgrade, State(broker): State<SharedBroker>) -> Response {
    ws.on_upgrade(move |socket| serve_connection(socket, broker, Role::Pwa))
}

/// Drive one WebSocket connection: register it, pump queued server messages to
/// the socket on one task, and process inbound client messages on this one.
async fn serve_connection(socket: WebSocket, broker: SharedBroker, role: Role) {
    let conn = broker.next_conn.fetch_add(1, Ordering::Relaxed);
    let (tx, mut rx) = unbounded_channel::<String>();
    broker.register(conn, role, tx);
    tracing::debug!(conn, ?role, "connection established");

    let (mut sink, mut stream) = socket.split();
    // Outbound pump: everything the broker sends this client flows through the
    // mpsc channel so state mutations never block on socket back-pressure. A
    // periodic Ping keeps idle connections alive under proxy/LB idle timeouts on
    // a day-long wait (clients auto-pong); a send failure tears the pump down.
    let ping_ms = broker.ping_ms;
    let send_task = tokio::spawn(async move {
        let mut heartbeat = tokio::time::interval(std::time::Duration::from_millis(ping_ms));
        loop {
            tokio::select! {
                queued = rx.recv() => match queued {
                    Some(text) => {
                        if sink.send(Message::Text(text.into())).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                },
                _ = heartbeat.tick() => {
                    if sink.send(Message::Ping(Default::default())).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    while let Some(Ok(message)) = stream.next().await {
        match message {
            Message::Text(text) => {
                if let Ok(value) = serde_json::from_str::<Value>(text.as_str()) {
                    broker.on_message(conn, role, value);
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    broker.disconnect(conn, role);
    send_task.abort();
    tracing::debug!(conn, ?role, "connection closed");
}

impl Broker {
    fn register(&self, conn: u64, role: Role, tx: UnboundedSender<String>) {
        let mut inner = self.inner.lock().unwrap();
        match role {
            Role::Daemon => inner.daemons.insert(conn, tx),
            Role::Pwa => inner.pwas.insert(conn, tx),
        };
    }

    /// Route one inbound client message. Pure dispatch; the mutations live in the
    /// helpers so they can be unit-tested without a socket.
    pub fn on_message(&self, conn: u64, role: Role, message: Value) {
        let kind = message_kind(&message);
        match (role, kind) {
            (Role::Daemon, "create") => {
                if let Some(request) = message.get("request") {
                    self.create(conn, request.clone());
                }
            }
            (_, "decision") => {
                if let Some(id) = message.get("requestId").and_then(Value::as_str) {
                    let verdict = message
                        .get("verdict")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let reason = message
                        .get("reason")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    self.resolve(id, Some((verdict, reason)), role == Role::Daemon);
                }
            }
            (Role::Daemon, "withdraw") => {
                if let Some(id) = message.get("requestId").and_then(Value::as_str) {
                    self.resolve(id, None, true);
                }
            }
            (Role::Pwa, "subscribe") => self.send_snapshot(conn),
            _ => {}
        }
    }

    /// A daemon opened a request: record ownership and fan it out to every PWA.
    fn create(&self, owner: u64, request: Value) {
        let Some(id) = request
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            return; // a request without an id cannot be routed or dismissed
        };
        let mut inner = self.inner.lock().unwrap();
        // Idempotent re-announce: a daemon reconnecting to a broker that still has
        // the request only updates its owner (the daemon's connection id changed)
        // and must not broadcast a duplicate card. A genuinely new id — including
        // one re-announced to a broker that restarted and lost its state — fans out.
        if let Some(existing) = inner.requests.get_mut(&id) {
            existing.owner = owner;
            existing.request = request;
            return;
        }
        let added = added_message(&request);
        inner.requests.insert(id, Pending { request, owner });
        broadcast(&inner.pwas, &added);
    }

    /// Resolve a request from either side. The first resolution wins; later ones
    /// are no-ops because the request is already gone. A web decision is routed
    /// to the owning daemon; a daemon-originated decision (local terminal) is
    /// not echoed back to its source. Either way, every PWA is told to dismiss.
    fn resolve(&self, id: &str, decision: Option<(String, String)>, from_daemon: bool) {
        let mut inner = self.inner.lock().unwrap();
        let Some(pending) = inner.requests.remove(id) else {
            return;
        };
        if let (Some((verdict, reason)), false) = (&decision, from_daemon) {
            if let Some(tx) = inner.daemons.get(&pending.owner) {
                let _ = tx.send(decision_message(id, verdict, reason));
            }
        }
        let resolved = resolved_message(id);
        broadcast(&inner.pwas, &resolved);
    }

    /// Send a newly-subscribed PWA the current pending set so it renders
    /// immediately without waiting for the next `added`.
    fn send_snapshot(&self, conn: u64) {
        let inner = self.inner.lock().unwrap();
        let requests: Vec<&Value> = inner.requests.values().map(|p| &p.request).collect();
        let snapshot = snapshot_message(&requests);
        if let Some(tx) = inner.pwas.get(&conn) {
            let _ = tx.send(snapshot);
        }
    }

    /// Drop a connection. When a daemon disconnects, withdraw everything it owned
    /// so no PWA is left showing a prompt nothing is waiting on.
    fn disconnect(&self, conn: u64, role: Role) {
        let mut inner = self.inner.lock().unwrap();
        match role {
            Role::Pwa => {
                inner.pwas.remove(&conn);
            }
            Role::Daemon => {
                inner.daemons.remove(&conn);
                let orphaned: Vec<String> = inner
                    .requests
                    .iter()
                    .filter(|(_, pending)| pending.owner == conn)
                    .map(|(id, _)| id.clone())
                    .collect();
                for id in orphaned {
                    inner.requests.remove(&id);
                    let resolved = resolved_message(&id);
                    broadcast(&inner.pwas, &resolved);
                }
            }
        }
    }
}

fn broadcast(pwas: &HashMap<u64, UnboundedSender<String>>, text: &str) {
    for tx in pwas.values() {
        let _ = tx.send(text.to_string());
    }
}
