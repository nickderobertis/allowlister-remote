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

/// A broker running on its own dedicated thread + runtime, plus the channel and
/// join handle used to stop it when the test's `TestBroker` drops at end of
/// scope. Keeping the broker's runtime off the test's runtime matters on
/// Windows: dropping a tokio runtime that still has a task blocked in a pending
/// IOCP `accept` hangs, so a broker left on the test runtime would hang the whole
/// `cargo test` process after the suite passes. Here the broker's runtime is
/// built, driven, and force-stopped (bounded `shutdown_timeout`) entirely on its
/// own thread, so the test runtime tears down with nothing pending.
struct TestBroker {
    url: String,
    stop: Option<std::sync::mpsc::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Drop for TestBroker {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn start_broker() -> TestBroker {
    let (addr_tx, addr_rx) = std::sync::mpsc::channel();
    let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
    let thread = std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .unwrap();
        rt.spawn(async move {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let _ = addr_tx.send(listener.local_addr().unwrap());
            let _ = axum::serve(listener, app(Arc::new(Broker::default()))).await;
        });
        // Block this dedicated thread until the test signals stop, then force the
        // runtime down within a bounded window so a pending IOCP accept can never
        // hang teardown — and it never touches the test's own runtime.
        let _ = stop_rx.recv();
        rt.shutdown_timeout(Duration::from_millis(500));
    });
    let addr = addr_rx.recv().expect("broker failed to bind");
    TestBroker {
        url: format!("ws://{addr}"),
        stop: Some(stop_tx),
        thread: Some(thread),
    }
}

async fn connect(base: &str, path: &str) -> Ws {
    // Bound the dial so a connect regression fails fast instead of hanging.
    let (ws, _) = tokio::time::timeout(
        Duration::from_secs(5),
        connect_async(format!("{base}{path}")),
    )
    .await
    .expect("timed out connecting to the broker")
    .unwrap();
    ws
}

async fn send(ws: &mut Ws, value: Value) {
    ws.send(Message::Text(value.to_string())).await.unwrap();
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
    let broker = start_broker();
    let base = broker.url.clone();
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
    assert_eq!(
        recv(&mut pwa_a).await,
        json!({"type":"resolved","requestId":"r1"})
    );
    assert_eq!(
        recv(&mut pwa_b).await,
        json!({"type":"resolved","requestId":"r1"})
    );
    drop(broker);
}

#[tokio::test]
async fn local_terminal_decision_dismisses_web_without_echo_to_daemon() {
    let broker = start_broker();
    let base = broker.url.clone();
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
    assert_eq!(
        recv(&mut pwa).await,
        json!({"type":"resolved","requestId":"r2"})
    );

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
    assert_eq!(
        next["requestId"], "r3",
        "daemon should not have received an r2 echo"
    );
    drop(broker);
}

#[tokio::test]
async fn subscribe_snapshot_includes_in_flight_requests() {
    let broker = start_broker();
    let base = broker.url.clone();
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
    drop(broker);
}

#[tokio::test]
async fn daemon_disconnect_withdraws_its_pending_requests() {
    let broker = start_broker();
    let base = broker.url.clone();
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
    tokio::time::timeout(Duration::from_secs(5), daemon.close(None))
        .await
        .expect("timed out closing the daemon connection")
        .unwrap();
    assert_eq!(
        recv(&mut pwa).await,
        json!({"type":"resolved","requestId":"r5"})
    );
    drop(broker);
}

#[tokio::test]
async fn many_daemons_and_pwas_all_interoperate() {
    // The core single-broker guarantee: every PWA sees every daemon's requests,
    // any PWA can decide any daemon's request, and each decision routes to the one
    // owning daemon — never to the wrong one.
    let broker = start_broker();
    let base = broker.url.clone();
    let mut daemon_a = connect(&base, "/ws/daemon").await;
    let mut daemon_b = connect(&base, "/ws/daemon").await;
    let mut pwa_a = connect(&base, "/ws/pwa").await;
    let mut pwa_b = connect(&base, "/ws/pwa").await;

    for pwa in [&mut pwa_a, &mut pwa_b] {
        send(pwa, json!({"type":"subscribe"})).await;
        assert_eq!(recv(pwa).await["type"], "snapshot");
    }

    // Two different daemons each open a request.
    send(
        &mut daemon_a,
        json!({"type":"create","request":{"id":"rA","command":"deploy A"}}),
    )
    .await;
    send(
        &mut daemon_b,
        json!({"type":"create","request":{"id":"rB","command":"deploy B"}}),
    )
    .await;

    // Every PWA sees both requests regardless of which daemon opened them.
    for pwa in [&mut pwa_a, &mut pwa_b] {
        let mut ids: std::collections::HashSet<String> = std::collections::HashSet::new();
        for _ in 0..2 {
            let added = recv(pwa).await;
            assert_eq!(added["type"], "added");
            ids.insert(added["request"]["id"].as_str().unwrap().to_string());
        }
        assert_eq!(
            ids,
            std::collections::HashSet::from(["rA".to_string(), "rB".to_string()]),
        );
    }

    // PWA A decides daemon B's request: it must route to daemon B, and every PWA
    // is told it resolved.
    send(
        &mut pwa_a,
        json!({"type":"decision","requestId":"rB","verdict":"allow","reason":"ok B"}),
    )
    .await;
    let to_b = recv(&mut daemon_b).await;
    assert_eq!(to_b["requestId"], "rB");
    assert_eq!(to_b["verdict"], "allow");
    for pwa in [&mut pwa_a, &mut pwa_b] {
        assert_eq!(recv(pwa).await, json!({"type":"resolved","requestId":"rB"}));
    }

    // PWA B decides daemon A's request. Daemon A's first-ever inbound message is
    // this rA decision (proving it never received rB's), routed only to it.
    send(
        &mut pwa_b,
        json!({"type":"decision","requestId":"rA","verdict":"deny","reason":"no A"}),
    )
    .await;
    let to_a = recv(&mut daemon_a).await;
    assert_eq!(to_a["requestId"], "rA");
    assert_eq!(to_a["verdict"], "deny");
    for pwa in [&mut pwa_a, &mut pwa_b] {
        assert_eq!(recv(pwa).await, json!({"type":"resolved","requestId":"rA"}));
    }
    drop(broker);
}

#[tokio::test]
async fn broker_sends_heartbeat_pings() {
    // A short interval so the keepalive is observable quickly. Pings keep an idle
    // connection alive through proxy/LB idle timeouts during a long wait.
    std::env::set_var("ALLOWLISTER_REMOTE_BROKER_PING_MS", "150");
    let broker = start_broker();
    let base = broker.url.clone();
    let mut pwa = connect(&base, "/ws/pwa").await;

    let got_ping = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            match pwa.next().await {
                Some(Ok(Message::Ping(_))) => return true,
                Some(Ok(_)) => continue,
                _ => return false,
            }
        }
    })
    .await
    .unwrap_or(false);
    assert!(got_ping, "expected a heartbeat ping from the broker");
    drop(broker);
}
