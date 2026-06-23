//! The allowlister-remote **daemon**: one long-lived process per host that
//! multiplexes the host's ephemeral plugin processes onto a single broker
//! connection.
//!
//! A plugin is spawned once per gated command and is short-lived, so it must not
//! hold the long upstream connection itself (a fresh TLS/auth handshake on every
//! gated command would tax the hot path). Instead each plugin connects to this
//! daemon over a local IPC channel — a Unix-domain socket on Unix, a named pipe
//! on Windows; the daemon holds the one WebSocket to the broker (which may live
//! on another machine) and routes decisions back to the right plugin.
//!
//! The broker connection is supervised: it reconnects with backoff and
//! **re-announces** every still-pending request on reconnect, so an approval that
//! is open for hours or days survives a dropped link or a broker restart. The
//! broker treats a re-announce idempotently (see `Broker::create`).
//!
//! ## Plugin ↔ daemon protocol (newline-delimited JSON over the unix socket)
//!
//! plugin → daemon:
//! * `{"type":"create","payload":{…}}` — the allowlister create body; the daemon
//!   assigns the request id and forwards it to the broker.
//! * `{"type":"decision","verdict":"allow|deny","reason":…}` — the operator
//!   decided at the local terminal; relay it upstream to dismiss the web prompt.
//!
//! daemon → plugin:
//! * `{"type":"decision","verdict":…,"reason":…}` — a web decision, routed down.
//! * `{"type":"ack"}` — a relayed local decision was forwarded upstream; the
//!   plugin may exit knowing the web prompt will be dismissed.

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::ser::{SerializeMap, Serializer};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, connect_async_tls_with_config, Connector};

pub struct Config {
    pub socket_path: String,
    pub broker_url: String,
    /// Optional path to a PEM CA bundle to trust for `wss://` (self-hosted or
    /// private-CA brokers). `None` uses the system trust store; ignored for
    /// `ws://`.
    pub ca_path: Option<String>,
}

/// A still-pending request: the verbatim `create` message (so it can be
/// re-announced after a reconnect) and the channel that wakes the plugin task
/// waiting on it.
struct PluginRoute {
    create_msg: String,
    decision_tx: UnboundedSender<String>,
}

type Routes = Arc<Mutex<HashMap<String, PluginRoute>>>;

/// Default local IPC address: per-user under `$XDG_RUNTIME_DIR` when available
/// (so it is private and cleaned up on logout), otherwise a uid-suffixed `/tmp`
/// path. Mirrors the plugin's `default_socket_path` so they meet at the same place.
#[cfg(unix)]
pub fn default_socket_path() -> String {
    if let Ok(dir) = std::env::var("XDG_RUNTIME_DIR") {
        if !dir.is_empty() {
            return format!("{dir}/allowlister-remote-daemon.sock");
        }
    }
    let uid = std::env::var("UID").unwrap_or_else(|_| "0".into());
    format!("/tmp/allowlister-remote-daemon-{uid}.sock")
}

/// Default local IPC address on Windows: a per-user named pipe. Mirrors the
/// plugin's `default_socket_path` so they meet at the same place.
#[cfg(windows)]
pub fn default_socket_path() -> String {
    let user = std::env::var("USERNAME").unwrap_or_else(|_| "default".into());
    format!(r"\\.\pipe\allowlister-remote-daemon-{user}")
}

pub fn default_broker_url() -> String {
    std::env::var("ALLOWLISTER_REMOTE_BROKER_URL")
        .unwrap_or_else(|_| "ws://127.0.0.1:4180/ws/daemon".into())
}

/// Run the daemon until the listener fails. The broker connection is supervised
/// on its own task, so a broker that is down at startup (or that restarts later)
/// does not stop the daemon from accepting plugins.
pub async fn serve(config: Config) -> std::io::Result<()> {
    // Install the process-default rustls crypto provider once so the no-CA
    // `wss://` path (connect_async's auto connector) has a provider. Idempotent;
    // a custom-CA connector supplies its own provider explicitly.
    let _ = rustls::crypto::ring::default_provider().install_default();

    let routes: Routes = Arc::new(Mutex::new(HashMap::new()));
    // One writer owns the broker connection; every plugin task sends through this
    // channel. While the link is down, messages queue here and flush on reconnect.
    let (broker_tx, broker_rx) = unbounded_channel::<String>();

    tokio::spawn(broker_loop(
        config.broker_url,
        config.ca_path,
        routes.clone(),
        broker_rx,
    ));

    accept_plugins(&config.socket_path, routes, broker_tx).await
}

/// Accept plugin connections over a Unix-domain socket and hand each to its own
/// task. A stale socket from a previous run would block the bind, so it is
/// removed first.
#[cfg(unix)]
async fn accept_plugins(
    socket_path: &str,
    routes: Routes,
    broker_tx: UnboundedSender<String>,
) -> std::io::Result<()> {
    let _ = std::fs::remove_file(socket_path);
    let listener = tokio::net::UnixListener::bind(socket_path)?;
    loop {
        let (stream, _) = listener.accept().await?;
        let routes = routes.clone();
        let broker_tx = broker_tx.clone();
        tokio::spawn(async move { handle_plugin(stream, routes, broker_tx).await });
    }
}

/// Accept plugin connections over a Windows named pipe. Each instance serves one
/// client; once it connects, the next instance is created so the following
/// plugin can connect, and the connected one is handed to its own task.
#[cfg(windows)]
async fn accept_plugins(
    socket_path: &str,
    routes: Routes,
    broker_tx: UnboundedSender<String>,
) -> std::io::Result<()> {
    use tokio::net::windows::named_pipe::ServerOptions;

    let mut server = ServerOptions::new()
        .first_pipe_instance(true)
        .create(socket_path)?;
    loop {
        server.connect().await?;
        let connected = server;
        // Pre-create the next instance before serving this one, so a plugin that
        // connects in the gap is not refused.
        server = ServerOptions::new().create(socket_path)?;
        let routes = routes.clone();
        let broker_tx = broker_tx.clone();
        tokio::spawn(async move { handle_plugin(connected, routes, broker_tx).await });
    }
}

/// Supervise the single broker connection: connect (with capped backoff),
/// re-announce still-pending requests, then forward outbound plugin messages and
/// route inbound decisions until the link drops — and repeat.
async fn broker_loop(
    url: String,
    ca_path: Option<String>,
    routes: Routes,
    mut broker_rx: UnboundedReceiver<String>,
) {
    let mut backoff = Duration::from_millis(250);
    let max_backoff = Duration::from_secs(10);

    loop {
        let socket = match connect_broker(&url, ca_path.as_deref()).await {
            Ok((socket, _)) => socket,
            Err(_) => {
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(max_backoff);
                continue;
            }
        };
        backoff = Duration::from_millis(250);
        let (mut sink, mut stream) = socket.split();

        // Re-announce every still-pending request so a broker that lost its state
        // (restart) re-learns them and a live broker just refreshes ownership.
        let pending: Vec<String> = {
            let routes = routes.lock().unwrap();
            routes
                .values()
                .map(|route| route.create_msg.clone())
                .collect()
        };
        let mut link_alive = true;
        for create_msg in pending {
            if sink.send(Message::Text(create_msg)).await.is_err() {
                link_alive = false;
                break;
            }
        }

        // Connected: pump outbound plugin messages and route inbound decisions
        // until either side closes.
        while link_alive {
            tokio::select! {
                outbound = broker_rx.recv() => match outbound {
                    Some(text) => {
                        if sink.send(Message::Text(text)).await.is_err() {
                            link_alive = false;
                        }
                    }
                    None => return, // serve() dropped the sender: daemon is shutting down
                },
                inbound = stream.next() => match inbound {
                    Some(Ok(Message::Text(text))) => route_decision(&routes, text.as_str()),
                    Some(Ok(Message::Close(_))) | None => link_alive = false,
                    Some(Ok(_)) => {}
                    Some(Err(_)) => link_alive = false,
                },
            }
        }

        tokio::time::sleep(backoff).await;
    }
}

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Connect to the broker, handling `ws://` and `wss://`. A configured CA bundle
/// is trusted in addition to the system store (for self-hosted/private-CA
/// brokers); without one, `wss://` uses the system trust store and `ws://` is
/// plain.
async fn connect_broker(
    url: &str,
    ca_path: Option<&str>,
) -> Result<
    (
        WsStream,
        tokio_tungstenite::tungstenite::handshake::client::Response,
    ),
    tokio_tungstenite::tungstenite::Error,
> {
    match ca_path {
        Some(path) if !path.is_empty() => {
            connect_async_tls_with_config(url, None, false, tls_connector_with_ca(path)).await
        }
        _ => connect_async(url).await,
    }
}

/// Build a rustls connector that trusts the given PEM CA in addition to the
/// webpki system roots. Returns `None` on a read/parse failure, which falls back
/// to the default connector (and a clean handshake failure if the cert is
/// untrusted).
fn tls_connector_with_ca(ca_path: &str) -> Option<Connector> {
    let pem = std::fs::read(ca_path).ok()?;
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let mut reader = std::io::BufReader::new(&pem[..]);
    for certificate in rustls_pemfile::certs(&mut reader).flatten() {
        let _ = roots.add(certificate);
    }
    let config = rustls::ClientConfig::builder_with_provider(std::sync::Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .ok()?
    .with_root_certificates(roots)
    .with_no_client_auth();
    Some(Connector::Rustls(std::sync::Arc::new(config)))
}

fn route_decision(routes: &Routes, text: &str) {
    let Some(id) = decision_target(text) else {
        return;
    };
    let sender = routes
        .lock()
        .unwrap()
        .get(&id)
        .map(|route| route.decision_tx.clone());
    if let Some(sender) = sender {
        let _ = sender.send(text.to_string());
    }
}

/// Borrowed view of an inbound broker frame, reading only the two fields routing
/// needs. `Cow` borrows straight out of the input buffer when the value has no
/// JSON escapes — request ids never do — and allocates only on the rare escaped
/// string, so the common case parses without building the whole `Value` tree
/// (the verdict/reason fields a decision also carries are skipped, not allocated).
#[derive(Deserialize)]
struct DecisionFrame<'a> {
    #[serde(default, borrow, rename = "type")]
    kind: Option<Cow<'a, str>>,
    #[serde(default, borrow, rename = "requestId")]
    request_id: Option<Cow<'a, str>>,
}

/// Extract the target request id from an inbound broker frame, if it is a
/// `decision` addressed to a pending request. This is the pure parse half of
/// `route_decision` — the routing-table lookup that follows is shared state, not
/// measured by the protocol benches that exercise this.
pub fn decision_target(text: &str) -> Option<String> {
    let frame: DecisionFrame = serde_json::from_str(text).ok()?;
    if frame.kind.as_deref() != Some("decision") {
        return None;
    }
    frame.request_id.map(Cow::into_owned)
}

/// The forwarded allowlister request with the daemon-assigned `id` injected,
/// serialized directly from the plugin's borrowed `payload`. Streaming the
/// payload's entries through the serializer (plus the id) avoids cloning the
/// whole payload subtree into an intermediate `Value` just to insert one field —
/// the dominant cost on this, the per-gated-command hot path.
struct RequestWithId<'a> {
    payload: Option<&'a Value>,
    id: &'a str,
}

impl Serialize for RequestWithId<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self.payload {
            // The common case: the plugin's create body is an object. Stream its
            // entries straight through (dropping any pre-existing `id`, which the
            // daemon owns) and append the assigned id — no clone of the subtree.
            Some(Value::Object(fields)) => {
                let mut map = serializer.serialize_map(Some(fields.len() + 1))?;
                for (key, value) in fields {
                    if key != "id" {
                        map.serialize_entry(key, value)?;
                    }
                }
                map.serialize_entry("id", self.id)?;
                map.end()
            }
            // A missing or non-object payload degrades to a `{payload, id}`
            // wrapper, mirroring the original `json!({ "payload": other })`.
            other => {
                let mut map = serializer.serialize_map(Some(2))?;
                map.serialize_entry("payload", &other)?;
                map.serialize_entry("id", self.id)?;
                map.end()
            }
        }
    }
}

#[derive(Serialize)]
struct CreateEnvelope<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    request: RequestWithId<'a>,
}

/// Build the broker `create` envelope from a plugin's parsed `create` message,
/// stamping the daemon-assigned `id` into the forwarded allowlister body. Pure:
/// no IO and no id generation (the caller passes the id), so the output is a
/// deterministic function of its inputs — exactly the per-gated-command work the
/// daemon does between reading the plugin's line and sending it upstream.
pub fn build_create_msg(create: &Value, id: &str) -> String {
    serde_json::to_string(&CreateEnvelope {
        kind: "create",
        request: RequestWithId {
            payload: create.get("payload"),
            id,
        },
    })
    .expect("create envelope serializes to JSON")
}

/// Handle one plugin connection: register its request with the broker, then race
/// a web decision (from the broker) against a local-terminal decision or the
/// plugin's disconnect (from the IPC channel). First outcome wins. Generic over
/// the transport so the same logic serves a Unix socket and a Windows named pipe.
async fn handle_plugin<S>(stream: S, routes: Routes, broker_tx: UnboundedSender<String>)
where
    S: AsyncRead + AsyncWrite + Send + 'static,
{
    let (read_half, mut write_half) = tokio::io::split(stream);
    let mut lines = BufReader::new(read_half).lines();

    let Ok(Some(first)) = lines.next_line().await else {
        return;
    };
    let Ok(create) = serde_json::from_str::<Value>(&first) else {
        return;
    };
    if create.get("type").and_then(Value::as_str) != Some("create") {
        return;
    }

    // The daemon owns the id space; the plugin just forwards its allowlister body.
    let id = new_request_id();
    let create_msg = build_create_msg(&create, &id);

    let (decision_tx, mut decision_rx) = unbounded_channel::<String>();
    routes.lock().unwrap().insert(
        id.clone(),
        PluginRoute {
            create_msg: create_msg.clone(),
            decision_tx,
        },
    );
    let _ = broker_tx.send(create_msg);

    loop {
        tokio::select! {
            // A web decision arrived on the broker connection.
            remote = decision_rx.recv() => {
                if let Some(text) = remote {
                    let _ = write_half.write_all(format!("{text}\n").as_bytes()).await;
                }
                break;
            }
            // The plugin sent a local decision, or its socket closed.
            line = lines.next_line() => {
                match line {
                    Ok(Some(raw)) => {
                        if let Some((verdict, reason)) = local_decision(&raw) {
                            let _ = broker_tx.send(json!({
                                "type":"decision","requestId":id,"verdict":verdict,"reason":reason
                            }).to_string());
                            let _ = write_half.write_all(b"{\"type\":\"ack\"}\n").await;
                            break;
                        }
                        // Unrecognized line: ignore and keep waiting.
                    }
                    // EOF: the plugin process exited before any decision. Withdraw
                    // the request so the web app stops showing a dead prompt.
                    _ => {
                        let _ = broker_tx.send(json!({ "type":"withdraw","requestId":id }).to_string());
                        break;
                    }
                }
            }
        }
    }

    routes.lock().unwrap().remove(&id);
}

/// Borrowed view of a local-terminal decision line: its `type`, `verdict`, and
/// `reason`. Like [`DecisionFrame`], `Cow` keeps the common (escape-free) line
/// zero-copy and only allocates the owned strings the caller keeps.
#[derive(Deserialize)]
struct LocalDecisionFrame<'a> {
    #[serde(default, borrow, rename = "type")]
    kind: Option<Cow<'a, str>>,
    #[serde(default, borrow)]
    verdict: Option<Cow<'a, str>>,
    #[serde(default, borrow)]
    reason: Option<Cow<'a, str>>,
}

/// Parse a line the plugin relays from the local terminal into a `(verdict,
/// reason)` pair, or `None` if it is not a well-formed `decision`. Pure: the
/// per-line work the daemon does on a local-terminal decision before forwarding
/// it upstream.
pub fn local_decision(raw: &str) -> Option<(String, String)> {
    let frame: LocalDecisionFrame = serde_json::from_str(raw).ok()?;
    if frame.kind.as_deref() != Some("decision") {
        return None;
    }
    let verdict = frame.verdict?.into_owned();
    let reason = frame.reason.map(Cow::into_owned).unwrap_or_default();
    Some((verdict, reason))
}

/// A process-unique request id without a uuid dependency: pid + a monotonic
/// nanosecond clock + a per-process counter. Unique across the daemon's lifetime
/// and across hosts (the broker namespaces by connection anyway).
fn new_request_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{}-{}-{}", std::process::id(), nanos, seq)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The broker `create` envelope must carry the plugin's payload verbatim with
    /// the daemon-assigned `id` injected. Key order is free to differ from the old
    /// `Value`-built output (the broker parses it as an object), so the guarantee
    /// is semantic: the parsed frame matches the expected JSON.
    #[test]
    fn build_create_msg_injects_id_and_forwards_payload() {
        let create = json!({
            "type": "create",
            "payload": { "command": "gh pr merge 42", "subject": "shell" },
        });
        let parsed: Value = serde_json::from_str(&build_create_msg(&create, "id-7")).unwrap();
        assert_eq!(
            parsed,
            json!({
                "type": "create",
                "request": { "command": "gh pr merge 42", "subject": "shell", "id": "id-7" },
            })
        );
    }

    /// The daemon owns the id space: a payload that already carries an `id` has it
    /// overwritten by the assigned one, never duplicated.
    #[test]
    fn build_create_msg_overrides_a_preexisting_id() {
        let create = json!({ "type": "create", "payload": { "id": "stale", "command": "ls" } });
        let parsed: Value = serde_json::from_str(&build_create_msg(&create, "id-9")).unwrap();
        assert_eq!(parsed["request"]["id"], "id-9");
        assert_eq!(parsed["request"]["command"], "ls");
    }

    /// A missing or non-object payload degrades to a `{payload, id}` wrapper rather
    /// than panicking, matching the original fallback.
    #[test]
    fn build_create_msg_wraps_missing_or_nonobject_payload() {
        let parsed: Value =
            serde_json::from_str(&build_create_msg(&json!({ "type": "create" }), "id-1")).unwrap();
        assert_eq!(parsed["request"], json!({ "payload": null, "id": "id-1" }));

        let create = json!({ "type": "create", "payload": ["a", "b"] });
        let parsed: Value = serde_json::from_str(&build_create_msg(&create, "id-2")).unwrap();
        assert_eq!(
            parsed["request"],
            json!({ "payload": ["a", "b"], "id": "id-2" })
        );
    }

    #[test]
    fn decision_target_extracts_only_decision_request_ids() {
        assert_eq!(
            decision_target(r#"{"type":"decision","requestId":"req_1","verdict":"allow"}"#),
            Some("req_1".to_string())
        );
        // Wrong type, missing id, and unparseable input all yield None.
        assert_eq!(
            decision_target(r#"{"type":"withdraw","requestId":"r"}"#),
            None
        );
        assert_eq!(decision_target(r#"{"type":"decision"}"#), None);
        assert_eq!(decision_target("not json"), None);
    }

    #[test]
    fn local_decision_parses_verdict_and_reason() {
        assert_eq!(
            local_decision(r#"{"type":"decision","verdict":"deny","reason":"nope"}"#),
            Some(("deny".to_string(), "nope".to_string()))
        );
        // A missing reason defaults to empty; a JSON-escaped reason round-trips.
        assert_eq!(
            local_decision(r#"{"type":"decision","verdict":"allow"}"#),
            Some(("allow".to_string(), String::new()))
        );
        assert_eq!(
            local_decision(r#"{"type":"decision","verdict":"deny","reason":"a\"b\n"}"#),
            Some(("deny".to_string(), "a\"b\n".to_string()))
        );
        // Not a decision, or missing the verdict, or garbage: None.
        assert_eq!(local_decision(r#"{"type":"ack"}"#), None);
        assert_eq!(local_decision(r#"{"type":"decision"}"#), None);
        assert_eq!(local_decision("{"), None);
    }
}
