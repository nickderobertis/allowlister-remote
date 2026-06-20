//! Binary entry point for the allowlister-remote broker. Binds a TCP listener
//! and serves the WebSocket mediation app. Address comes from
//! `ALLOWLISTER_REMOTE_BROKER_ADDR` (default `127.0.0.1:4180`).

use std::sync::Arc;

use allowlister_remote_broker::{app, Broker};

#[tokio::main]
async fn main() {
    let addr =
        std::env::var("ALLOWLISTER_REMOTE_BROKER_ADDR").unwrap_or_else(|_| "127.0.0.1:4180".into());
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|error| panic!("broker failed to bind {addr}: {error}"));
    let bound = listener.local_addr().expect("listener has a local address");
    println!("allowlister-remote-broker mediating on ws://{bound}");

    axum::serve(listener, app(Arc::new(Broker::default())))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .expect("broker serve loop");
}
