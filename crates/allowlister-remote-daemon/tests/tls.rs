//! Proves the daemon dials the broker over `wss://` with a custom-trusted CA.
//!
//! A real broker is plaintext `ws://` behind a TLS-terminating proxy, so here a
//! self-signed TLS WebSocket server stands in for that proxy/broker endpoint. We
//! generate a cert, trust it via `Config::ca_path`, point the daemon at a
//! `wss://localhost:PORT/ws/daemon` URL, and assert that a request opened by a
//! plugin arrives over the TLS link — i.e. the daemon completed a real TLS
//! WebSocket handshake and forwarded the `create`.
//!
//! Unix-only: the fake plugin connects to the daemon over a Unix-domain socket.

use std::time::Duration;

use allowlister_remote_daemon::{serve, Config};
use futures_util::StreamExt;
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, UnixStream};
use tokio::sync::oneshot;
use tokio_tungstenite::tungstenite::Message;

#[tokio::test]
async fn daemon_connects_to_broker_over_wss_with_custom_ca() {
    // Self-signed cert for "localhost" (a DNS SAN, so native-tls's hostname
    // verification passes when we dial wss://localhost).
    let cert = rcgen::generate_simple_self_signed(vec!["localhost".to_string()]).unwrap();
    let cert_pem = cert.cert.pem();
    let key_pem = cert.key_pair.serialize_pem();

    let ca_file =
        std::env::temp_dir().join(format!("allowlister-wss-ca-{}.pem", std::process::id()));
    std::fs::write(&ca_file, &cert_pem).unwrap();

    // TLS WebSocket server standing in for the broker's /ws/daemon endpoint.
    let identity =
        native_tls::Identity::from_pkcs8(cert_pem.as_bytes(), key_pem.as_bytes()).unwrap();
    let acceptor =
        tokio_native_tls::TlsAcceptor::from(native_tls::TlsAcceptor::new(identity).unwrap());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    let (got_create_tx, got_create_rx) = oneshot::channel::<serde_json::Value>();
    tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let tls = acceptor.accept(tcp).await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(tls).await.unwrap();
        // The first text frame the daemon sends is the forwarded `create`.
        while let Some(Ok(message)) = ws.next().await {
            if let Message::Text(text) = message {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    if value.get("type").and_then(|v| v.as_str()) == Some("create") {
                        let _ = got_create_tx.send(value);
                        break;
                    }
                }
            }
        }
    });

    // Run the daemon against the wss endpoint, trusting our self-signed CA.
    let socket_path =
        std::env::temp_dir().join(format!("allowlister-wss-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&socket_path);
    let config = Config {
        socket_path: socket_path.to_string_lossy().into_owned(),
        broker_url: format!("wss://localhost:{port}/ws/daemon"),
        ca_path: Some(ca_file.to_string_lossy().into_owned()),
    };
    tokio::spawn(async move {
        serve(config).await.unwrap();
    });

    // A plugin opens a request; the daemon must forward it over the TLS link.
    let socket_path_str = socket_path.to_string_lossy().into_owned();
    let mut plugin = None;
    for _ in 0..200 {
        if let Ok(stream) = UnixStream::connect(&socket_path_str).await {
            plugin = Some(stream);
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let mut plugin = plugin.expect("daemon socket never came up");
    plugin
        .write_all(b"{\"type\":\"create\",\"payload\":{\"subject\":\"shell\",\"command\":\"tls hello\"}}\n")
        .await
        .unwrap();

    let create = tokio::time::timeout(Duration::from_secs(10), got_create_rx)
        .await
        .expect("timed out waiting for the create over wss")
        .expect("server task dropped the sender");
    assert_eq!(create["request"]["command"], "tls hello");

    let _ = std::fs::remove_file(&socket_path);
    let _ = std::fs::remove_file(&ca_file);
}
