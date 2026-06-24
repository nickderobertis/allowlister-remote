//! Binary entry point for the allowlister-remote broker. Binds a TCP listener
//! and serves the WebSocket mediation app. Address comes from
//! `ALLOWLISTER_REMOTE_BROKER_ADDR` (default `127.0.0.1:4180`).

use std::sync::Arc;

use allowlister_remote_broker::{app, Broker};

const HELP: &str = "\
allowlister-remote-broker — WebSocket mediator between daemons and PWAs

USAGE:
    allowlister-remote-broker [OPTIONS]

Serves /ws/daemon, /ws/pwa, and /healthz. Configuration comes from the
environment:

    ALLOWLISTER_REMOTE_BROKER_ADDR     listen address (default: 127.0.0.1:4180)
    ALLOWLISTER_REMOTE_BROKER_PING_MS  keepalive ping interval (default: 20000)
    RUST_LOG                           log filter, e.g. info, debug (default: info)

OPTIONS:
    -h, --help       Print this help and exit
    -V, --version    Print the version and exit";

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
    // `--help`/`--version` must print and exit *before* binding, so probing the
    // CLI on a host that already runs a broker does not fail with "address already
    // in use" (it used to fall through to the bind and panic — see issue #93).
    if std::env::args().any(|argument| argument == "--help" || argument == "-h") {
        println!("{HELP}");
        return;
    }
    if std::env::args().any(|argument| argument == "--version" || argument == "-V") {
        println!("{VERSION}");
        return;
    }

    init_tracing();

    let addr =
        std::env::var("ALLOWLISTER_REMOTE_BROKER_ADDR").unwrap_or_else(|_| "127.0.0.1:4180".into());
    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(listener) => listener,
        Err(error) => {
            // A clean, actionable message and a non-zero exit beat a panic backtrace
            // for the common "another broker is already bound" case.
            tracing::error!(%addr, %error, "broker failed to bind");
            std::process::exit(1);
        }
    };
    let bound = listener.local_addr().expect("listener has a local address");
    tracing::info!(%bound, "allowlister-remote-broker mediating on ws://{bound}");

    if let Err(error) = axum::serve(listener, app(Arc::new(Broker::default())))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
    {
        tracing::error!(%error, "broker serve loop exited");
        std::process::exit(1);
    }
}

/// Install a `RUST_LOG`-driven log subscriber writing to stderr, defaulting to
/// `info` when `RUST_LOG` is unset, so the broker reports binds, connections, and
/// errors out of the box and `RUST_LOG=debug` traces per-connection routing.
/// `try_init` so a test that already installed a subscriber does not panic.
fn init_tracing() {
    use tracing_subscriber::{fmt, EnvFilter};
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .try_init();
}
