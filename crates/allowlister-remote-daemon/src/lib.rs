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

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
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
    std::env::var("ALLOWLISTER_REMOTE_BROKER_URL").unwrap_or_else(|_| "ws://127.0.0.1:4180".into())
}

/// Resolve the daemon's broker WebSocket endpoint from a configured broker URL.
///
/// The broker URL is the broker *base* — `ws://127.0.0.1:4180` or
/// `wss://broker.example.com` — the same value the broker advertises as its
/// listen address and the PWA stores as its setting. The daemon's endpoint is
/// `<base>/ws/daemon`, exactly mirroring the `<base>/ws/pwa` the PWA derives in
/// `apps/web/src/lib/broker-config.ts`. The broker only routes `/ws/daemon` and
/// `/ws/pwa`, so a daemon that dialed the bare base would hit `/` — which has no
/// route — and the WebSocket upgrade would fail, so every approval silently
/// failed to reach the PWA (see issue #93).
///
/// Idempotent: a URL that already targets `/ws/daemon` (the historical default,
/// and what the e2e suite passes) is returned unchanged, so both the bare base
/// and a full endpoint URL work. A trailing slash on the base is tolerated.
pub fn daemon_ws_url(base: &str) -> String {
    let trimmed = base.trim().trim_end_matches('/');
    if trimmed.ends_with("/ws/daemon") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/ws/daemon")
    }
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

    let broker_url = daemon_ws_url(&config.broker_url);
    tracing::info!(
        socket = %config.socket_path,
        broker = %broker_url,
        "daemon starting"
    );
    tokio::spawn(broker_loop(
        broker_url,
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
            Err(error) => {
                // The single most useful line for triaging a dead broker link: the
                // exact endpoint and why the dial/upgrade failed (a wrong path
                // surfaces here as an HTTP error, not a 101). See issue #93.
                tracing::warn!(broker = %url, %error, ?backoff, "broker connection failed; retrying");
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(max_backoff);
                continue;
            }
        };
        tracing::info!(broker = %url, "broker link established");
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
        if !pending.is_empty() {
            tracing::debug!(count = pending.len(), "re-announcing pending requests");
        }
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

        tracing::warn!(broker = %url, "broker link dropped; reconnecting");
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

/// Extract the target request id from an inbound broker frame, if it is a
/// `decision` addressed to a pending request. This is the pure parse half of
/// `route_decision` — the routing-table lookup that follows is shared state, not
/// measured by the protocol benches that exercise this.
pub fn decision_target(text: &str) -> Option<String> {
    let value: Value = serde_json::from_str(text).ok()?;
    if value.get("type").and_then(Value::as_str) != Some("decision") {
        return None;
    }
    value
        .get("requestId")
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Build the broker `create` envelope from a plugin's parsed `create` message,
/// stamping the daemon-assigned `id` into the forwarded allowlister body. Pure:
/// no IO and no id generation (the caller passes the id), so the output is a
/// deterministic function of its inputs — exactly the per-gated-command work the
/// daemon does between reading the plugin's line and sending it upstream.
pub fn build_create_msg(create: &Value, id: &str) -> String {
    let mut request = match create.get("payload").cloned() {
        Some(Value::Object(map)) => Value::Object(map),
        other => json!({ "payload": other }),
    };
    if let Value::Object(map) = &mut request {
        map.insert("id".to_string(), json!(id));
    }
    json!({ "type": "create", "request": request }).to_string()
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

/// Parse a line the plugin relays from the local terminal into a `(verdict,
/// reason)` pair, or `None` if it is not a well-formed `decision`. Pure: the
/// per-line work the daemon does on a local-terminal decision before forwarding
/// it upstream.
pub fn local_decision(raw: &str) -> Option<(String, String)> {
    let value: Value = serde_json::from_str(raw).ok()?;
    if value.get("type").and_then(Value::as_str) != Some("decision") {
        return None;
    }
    let verdict = value.get("verdict").and_then(Value::as_str)?.to_string();
    let reason = value
        .get("reason")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
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
    use super::daemon_ws_url;

    #[test]
    fn bare_base_gains_the_ws_daemon_path() {
        // The natural user config — the broker's advertised listen address with no
        // path — must resolve to the `/ws/daemon` endpoint the broker routes.
        assert_eq!(
            daemon_ws_url("ws://127.0.0.1:4180"),
            "ws://127.0.0.1:4180/ws/daemon"
        );
        assert_eq!(
            daemon_ws_url("wss://broker.example.com"),
            "wss://broker.example.com/ws/daemon"
        );
    }

    #[test]
    fn trailing_slash_on_the_base_is_tolerated() {
        assert_eq!(
            daemon_ws_url("ws://127.0.0.1:4180/"),
            "ws://127.0.0.1:4180/ws/daemon"
        );
    }

    #[test]
    fn a_full_endpoint_url_is_left_unchanged() {
        // Backward compatible: the historical form (and what the e2e suite passes)
        // already targets `/ws/daemon`, so it must not be doubled.
        assert_eq!(
            daemon_ws_url("ws://127.0.0.1:4180/ws/daemon"),
            "ws://127.0.0.1:4180/ws/daemon"
        );
        assert_eq!(
            daemon_ws_url("ws://127.0.0.1:4180/ws/daemon/"),
            "ws://127.0.0.1:4180/ws/daemon"
        );
    }

    #[test]
    fn a_reverse_proxy_prefix_is_preserved() {
        // A broker mounted under a path prefix keeps it; the endpoint is appended.
        assert_eq!(
            daemon_ws_url("wss://example.com/broker"),
            "wss://example.com/broker/ws/daemon"
        );
    }
}
