//! Binary entry point for the allowlister-remote broker. Binds a TCP listener
//! and serves the WebSocket mediation app. Address comes from
//! `ALLOWLISTER_REMOTE_BROKER_ADDR` (default `127.0.0.1:4180`).

use std::sync::Arc;

use allowlister_remote_broker::{app, Broker};

/// Broker version reported by `--version`. Release builds inject the published
/// version from the git tag via `ALLOWLISTER_REMOTE_PLUGIN_VERSION` (see
/// `publish.yml`), the same stamp-from-tag pattern the plugin and daemon use, so
/// the broker downloaded from a GitHub Release reports the tag it was cut from;
/// dev and test builds fall back to the crate's `Cargo.toml` version.
const VERSION: &str = match option_env!("ALLOWLISTER_REMOTE_PLUGIN_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};

#[tokio::main]
async fn main() {
    if std::env::args().any(|argument| argument == "--version" || argument == "-V") {
        println!("{VERSION}");
        return;
    }

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
