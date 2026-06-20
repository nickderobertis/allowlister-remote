//! The allowlister-remote **daemon**: one long-lived process per host that
//! multiplexes the host's ephemeral plugin processes onto a single broker
//! connection.
//!
//! A plugin is spawned once per gated command and is short-lived, so it must not
//! hold the long upstream connection itself (a fresh TLS/auth handshake on every
//! gated command would tax the hot path). Instead each plugin connects to this
//! daemon over a Unix-domain socket; the daemon holds the one WebSocket to the
//! broker and routes decisions back to the right plugin.
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

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

pub struct Config {
    pub socket_path: String,
    pub broker_url: String,
}

/// Maps a broker request id to the channel that wakes the plugin task waiting on
/// it, so a decision arriving on the single broker connection reaches the right
/// plugin among many.
type Routes = Arc<Mutex<HashMap<String, UnboundedSender<String>>>>;

/// Default socket path: per-user under `$XDG_RUNTIME_DIR` when available (so it
/// is private and cleaned up on logout), otherwise a uid-suffixed `/tmp` path.
pub fn default_socket_path() -> String {
    if let Ok(dir) = std::env::var("XDG_RUNTIME_DIR") {
        if !dir.is_empty() {
            return format!("{dir}/allowlister-remote-daemon.sock");
        }
    }
    let uid = std::env::var("UID").unwrap_or_else(|_| "0".into());
    format!("/tmp/allowlister-remote-daemon-{uid}.sock")
}

pub fn default_broker_url() -> String {
    std::env::var("ALLOWLISTER_REMOTE_BROKER_URL").unwrap_or_else(|_| "ws://127.0.0.1:4180".into())
}

/// Run the daemon until the listener fails. Connects upstream, then accepts
/// plugin connections forever.
pub async fn serve(config: Config) -> std::io::Result<()> {
    // A stale socket from a previous run would block the bind.
    let _ = std::fs::remove_file(&config.socket_path);
    let listener = UnixListener::bind(&config.socket_path)?;

    let (ws, _) = connect_async(&config.broker_url)
        .await
        .map_err(|error| std::io::Error::other(format!("broker connect failed: {error}")))?;
    let (mut ws_sink, mut ws_stream) = ws.split();

    // One writer task owns the broker sink; every plugin task sends through this
    // channel so state never blocks on socket back-pressure.
    let (broker_tx, mut broker_rx) = unbounded_channel::<String>();
    tokio::spawn(async move {
        while let Some(text) = broker_rx.recv().await {
            if ws_sink.send(Message::Text(text)).await.is_err() {
                break;
            }
        }
    });

    let routes: Routes = Arc::new(Mutex::new(HashMap::new()));

    // Broker reader: deliver each web decision to the plugin task awaiting it.
    {
        let routes = routes.clone();
        tokio::spawn(async move {
            while let Some(Ok(message)) = ws_stream.next().await {
                if let Message::Text(text) = message {
                    route_decision(&routes, text.as_str());
                }
            }
        });
    }

    loop {
        let (stream, _) = listener.accept().await?;
        let routes = routes.clone();
        let broker_tx = broker_tx.clone();
        tokio::spawn(async move { handle_plugin(stream, routes, broker_tx).await });
    }
}

fn route_decision(routes: &Routes, text: &str) {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return;
    };
    if value.get("type").and_then(Value::as_str) != Some("decision") {
        return;
    }
    let Some(id) = value.get("requestId").and_then(Value::as_str) else {
        return;
    };
    let sender = routes.lock().unwrap().get(id).cloned();
    if let Some(sender) = sender {
        let _ = sender.send(text.to_string());
    }
}

/// Handle one plugin connection: register its request with the broker, then race
/// a web decision (from the broker) against a local-terminal decision or the
/// plugin's disconnect (from the socket). First outcome wins.
async fn handle_plugin(stream: UnixStream, routes: Routes, broker_tx: UnboundedSender<String>) {
    let (read_half, mut write_half) = stream.into_split();
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
    let mut request = match create.get("payload").cloned() {
        Some(Value::Object(map)) => Value::Object(map),
        other => json!({ "payload": other }),
    };
    if let Value::Object(map) = &mut request {
        map.insert("id".to_string(), json!(id));
    }

    let (decision_tx, mut decision_rx) = unbounded_channel::<String>();
    routes.lock().unwrap().insert(id.clone(), decision_tx);
    let _ = broker_tx.send(json!({ "type": "create", "request": request }).to_string());

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

fn local_decision(raw: &str) -> Option<(String, String)> {
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
