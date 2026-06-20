//! End-to-end mediation tests: spin up the real broker on an ephemeral port and
//! drive it with genuine WebSocket clients standing in for a daemon and a PWA.
//! These assert the full relay path the design depends on — fan-out, decision
//! routing back to the owning daemon, the local-terminal relay, multi-instance
//! fan-out, and daemon-disconnect cleanup.

use std::sync::Arc;
use std::time::Duration;

use allowlister_remote_broker::{app, Broker};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn start_broker() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app(Arc::new(Broker::default())))
            .await
            .unwrap();
    });
    format!("ws://{addr}")
}

async fn connect(base: &str, path: &str) -> Ws {
    let (ws, _) = connect_async(format!("{base}{path}")).await.unwrap();
    ws
}

async fn send(ws: &mut Ws, value: Value) {
    ws.send(Message::Text(value.to_string().into())).await.unwrap();
}

/// Read the next JSON frame, ignoring pings/pongs, failing if nothing arrives in
/// time so a routing regression surfaces as a test failure rather than a hang.
async fn recv(ws: &mut Ws) -> Value {
    let deadline = Duration::from_secs(2);
    loop {
        let message = tokio::time::timeout(deadline, ws.next())
            .await
            .expect("timed out waiting for a broker message")
            .expect("stream ended")
            .expect("websocket error");
        match message {
            Message::Text(text) => return serde_json::from_str(text.as_str()).unwrap(),
            Message::Ping(_) | Message::Pong(_) => continue,
            Message::Close(_) => panic!("connection closed unexpectedly"),
            _ => continue,
        }
    }
}

#[tokio::test]
async fn web_decision_routes_back_to_owning_daemon_and_dismisses_all_pwas() {
    let base = start_broker().await;
    let mut daemon = connect(&base, "/ws/daemon").await;
    let mut pwa_a = connect(&base, "/ws/pwa").await;
    let mut pwa_b = connect(&base, "/ws/pwa").await;

    // Both PWA instances subscribe and start from an empty snapshot.
    send(&mut pwa_a, json!({"type":"subscribe"})).await;
    send(&mut pwa_b, json!({"type":"subscribe"})).await;
    assert_eq!(recv(&mut pwa_a).await["type"], "snapshot");
    assert_eq!(recv(&mut pwa_b).await["type"], "snapshot");

    // A daemon opens a request; every subscribed PWA is told about it.
    send(
        &mut daemon,
        json!({"type":"create","request":{"id":"r1","subject":"shell","command":"gh pr merge 42"}}),
    )
    .await;
    let added_a = recv(&mut pwa_a).await;
    let added_b = recv(&mut pwa_b).await;
    assert_eq!(added_a["type"], "added");
    assert_eq!(added_a["request"]["id"], "r1");
    assert_eq!(added_b["request"]["command"], "gh pr merge 42");

    // One PWA decides; the decision is routed to the owning daemon and both PWAs
    // are told to dismiss.
    send(
        &mut pwa_a,
        json!({"type":"decision","requestId":"r1","verdict":"allow","reason":"approved in app"}),
    )
    .await;
    let routed = recv(&mut daemon).await;
    assert_eq!(routed["type"], "decision");
    assert_eq!(routed["requestId"], "r1");
    assert_eq!(routed["verdict"], "allow");
    assert_eq!(routed["reason"], "approved in app");
    assert_eq!(recv(&mut pwa_a).await, json!({"type":"resolved","requestId":"r1"}));
    assert_eq!(recv(&mut pwa_b).await, json!({"type":"resolved","requestId":"r1"}));
}

#[tokio::test]
async fn local_terminal_decision_dismisses_web_without_echo_to_daemon() {
    let base = start_broker().await;
    let mut daemon = connect(&base, "/ws/daemon").await;
    let mut pwa = connect(&base, "/ws/pwa").await;
    send(&mut pwa, json!({"type":"subscribe"})).await;
    recv(&mut pwa).await; // snapshot

    send(
        &mut daemon,
        json!({"type":"create","request":{"id":"r2","subject":"shell","command":"rm -rf build"}}),
    )
    .await;
    assert_eq!(recv(&mut pwa).await["request"]["id"], "r2");

    // The operator decided at /dev/tty; the daemon relays it. The web prompt is
    // dismissed, and the broker does NOT echo the decision back to the daemon
    // that originated it.
    send(
        &mut daemon,
        json!({"type":"decision","requestId":"r2","verdict":"deny","reason":"denied at terminal"}),
    )
    .await;
    assert_eq!(recv(&mut pwa).await, json!({"type":"resolved","requestId":"r2"}));

    // Prove no echo: a fresh request must be the very next thing the daemon sees.
    send(
        &mut daemon,
        json!({"type":"create","request":{"id":"r3","subject":"shell","command":"ls"}}),
    )
    .await;
    send(
        &mut pwa,
        json!({"type":"decision","requestId":"r3","verdict":"allow","reason":"ok"}),
    )
    .await;
    let next = recv(&mut daemon).await;
    assert_eq!(next["requestId"], "r3", "daemon should not have received an r2 echo");
}

#[tokio::test]
async fn subscribe_snapshot_includes_in_flight_requests() {
    let base = start_broker().await;
    let mut daemon = connect(&base, "/ws/daemon").await;
    send(
        &mut daemon,
        json!({"type":"create","request":{"id":"r4","subject":"tool","tool":{"name":"write"}}}),
    )
    .await;

    // A PWA that connects after the request exists still sees it via the snapshot.
    let mut late = connect(&base, "/ws/pwa").await;
    send(&mut late, json!({"type":"subscribe"})).await;
    let snapshot = recv(&mut late).await;
    assert_eq!(snapshot["type"], "snapshot");
    assert_eq!(snapshot["requests"][0]["id"], "r4");
}

#[tokio::test]
async fn daemon_disconnect_withdraws_its_pending_requests() {
    let base = start_broker().await;
    let mut daemon = connect(&base, "/ws/daemon").await;
    let mut pwa = connect(&base, "/ws/pwa").await;
    send(&mut pwa, json!({"type":"subscribe"})).await;
    recv(&mut pwa).await; // snapshot

    send(
        &mut daemon,
        json!({"type":"create","request":{"id":"r5","subject":"shell","command":"sleep 1"}}),
    )
    .await;
    assert_eq!(recv(&mut pwa).await["request"]["id"], "r5");

    // The host went away (plugin killed, daemon crashed). The broker withdraws
    // the orphaned request so the web app stops showing a dead prompt.
    daemon.close(None).await.unwrap();
    assert_eq!(recv(&mut pwa).await, json!({"type":"resolved","requestId":"r5"}));
}
