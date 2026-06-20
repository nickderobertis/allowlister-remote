//! Full-chain test: a real broker + real daemon + a fake plugin (over the unix
//! socket) + a fake PWA (over a WebSocket to the broker). Exercises both
//! directions — a web decision routed down to the plugin, and a local-terminal
//! decision relayed up to dismiss the web prompt.

use std::sync::Arc;
use std::time::Duration;

use allowlister_remote_broker::{app, Broker};
use allowlister_remote_daemon::{serve, Config};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpStream, UnixStream};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Boot a broker and a daemon wired to it; return the broker ws base URL and the
/// daemon's unix socket path.
async fn start_stack() -> (String, String) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app(Arc::new(Broker::default()))).await.unwrap();
    });
    let base = format!("ws://{addr}");

    // Unique per stack: tests run in parallel in one process, so a shared path
    // would have the daemons clobber each other's socket.
    static STACK: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = STACK.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let socket_path = format!("/tmp/allowlister-daemon-test-{}-{n}.sock", std::process::id());
    let config = Config { socket_path: socket_path.clone(), broker_url: format!("{base}/ws/daemon") };
    tokio::spawn(async move {
        serve(config).await.unwrap();
    });

    (base, socket_path)
}

/// Connect to the daemon's unix socket, retrying until it is bound.
async fn connect_plugin(socket_path: &str) -> UnixStream {
    for _ in 0..200 {
        if let Ok(stream) = UnixStream::connect(socket_path).await {
            return stream;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("daemon socket never came up");
}

async fn ws_send(ws: &mut Ws, value: Value) {
    ws.send(Message::Text(value.to_string().into())).await.unwrap();
}

async fn ws_recv(ws: &mut Ws) -> Value {
    loop {
        let message = tokio::time::timeout(Duration::from_secs(3), ws.next())
            .await
            .expect("pwa recv timed out")
            .expect("stream ended")
            .expect("ws error");
        match message {
            Message::Text(text) => return serde_json::from_str(text.as_str()).unwrap(),
            Message::Ping(_) | Message::Pong(_) => continue,
            other => panic!("unexpected ws frame: {other:?}"),
        }
    }
}

#[tokio::test]
async fn web_decision_reaches_the_plugin_through_the_daemon() {
    let (base, socket_path) = start_stack().await;

    let mut pwa = connect_async(format!("{base}/ws/pwa")).await.unwrap().0;
    ws_send(&mut pwa, json!({"type":"subscribe"})).await;
    assert_eq!(ws_recv(&mut pwa).await["type"], "snapshot");

    // The plugin opens a request by writing one line to the daemon socket.
    let plugin = connect_plugin(&socket_path).await;
    let (plugin_read, mut plugin_write) = plugin.into_split();
    let mut plugin_lines = BufReader::new(plugin_read).lines();
    plugin_write
        .write_all(b"{\"type\":\"create\",\"payload\":{\"subject\":\"shell\",\"command\":\"gh pr merge 42\"}}\n")
        .await
        .unwrap();

    // The PWA sees the request (with a daemon-assigned id) and decides.
    let added = ws_recv(&mut pwa).await;
    assert_eq!(added["type"], "added");
    assert_eq!(added["request"]["command"], "gh pr merge 42");
    let id = added["request"]["id"].as_str().unwrap().to_string();

    ws_send(
        &mut pwa,
        json!({"type":"decision","requestId":id,"verdict":"allow","reason":"approved in app"}),
    )
    .await;
    assert_eq!(ws_recv(&mut pwa).await["type"], "resolved");

    // The decision is delivered down the unix socket to the waiting plugin.
    let line = tokio::time::timeout(Duration::from_secs(3), plugin_lines.next_line())
        .await
        .expect("plugin recv timed out")
        .unwrap()
        .unwrap();
    let decision: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(decision["type"], "decision");
    assert_eq!(decision["verdict"], "allow");
    assert_eq!(decision["reason"], "approved in app");
}

#[tokio::test]
async fn local_terminal_decision_relays_up_and_dismisses_web() {
    let (base, socket_path) = start_stack().await;

    let mut pwa = connect_async(format!("{base}/ws/pwa")).await.unwrap().0;
    ws_send(&mut pwa, json!({"type":"subscribe"})).await;
    assert_eq!(ws_recv(&mut pwa).await["type"], "snapshot");

    let plugin = connect_plugin(&socket_path).await;
    let (plugin_read, mut plugin_write) = plugin.into_split();
    let mut plugin_lines = BufReader::new(plugin_read).lines();
    plugin_write
        .write_all(b"{\"type\":\"create\",\"payload\":{\"subject\":\"shell\",\"command\":\"rm -rf build\"}}\n")
        .await
        .unwrap();
    assert_eq!(ws_recv(&mut pwa).await["type"], "added");

    // The operator typed 'd' at the terminal; the plugin relays it to the daemon.
    plugin_write
        .write_all(b"{\"type\":\"decision\",\"verdict\":\"deny\",\"reason\":\"denied at terminal\"}\n")
        .await
        .unwrap();

    // The daemon acks the plugin (so it may exit) and the web prompt is dismissed.
    let ack = tokio::time::timeout(Duration::from_secs(3), plugin_lines.next_line())
        .await
        .expect("plugin ack timed out")
        .unwrap()
        .unwrap();
    assert_eq!(serde_json::from_str::<Value>(&ack).unwrap()["type"], "ack");
    assert_eq!(ws_recv(&mut pwa).await["type"], "resolved");
}

#[tokio::test]
async fn plugin_exit_withdraws_the_request_from_web() {
    let (base, socket_path) = start_stack().await;

    let mut pwa = connect_async(format!("{base}/ws/pwa")).await.unwrap().0;
    ws_send(&mut pwa, json!({"type":"subscribe"})).await;
    assert_eq!(ws_recv(&mut pwa).await["type"], "snapshot");

    let plugin = connect_plugin(&socket_path).await;
    let (plugin_read, mut plugin_write) = plugin.into_split();
    drop(plugin_read);
    plugin_write
        .write_all(b"{\"type\":\"create\",\"payload\":{\"subject\":\"shell\",\"command\":\"sleep 1\"}}\n")
        .await
        .unwrap();
    let added = ws_recv(&mut pwa).await;
    assert_eq!(added["type"], "added");
    let id = added["request"]["id"].as_str().unwrap().to_string();

    // The gated command was Ctrl-C'd: the plugin process exits, closing the
    // socket. The daemon withdraws the request so the web prompt disappears.
    drop(plugin_write);
    assert_eq!(ws_recv(&mut pwa).await, json!({"type":"resolved","requestId":id}));
}
