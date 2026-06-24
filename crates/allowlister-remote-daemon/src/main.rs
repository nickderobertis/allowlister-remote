//! Binary entry point for the allowlister-remote daemon. Reads the socket path
//! and broker URL from the environment (with sensible per-user defaults) and
//! serves until interrupted. The plugin auto-starts this binary when no daemon
//! is already listening.

use allowlister_remote_daemon::{default_broker_url, default_socket_path, serve, Config};

const HELP: &str = "\
allowlister-remote-daemon — per-host bridge from allowlister plugins to the broker

USAGE:
    allowlister-remote-daemon [OPTIONS]

The daemon is normally auto-started by the plugin; run it directly only to
inspect it or to keep one resident. It reads its configuration from the
environment:

    ALLOWLISTER_REMOTE_DAEMON_SOCK   local IPC socket path (default: per-user)
    ALLOWLISTER_REMOTE_BROKER_URL    broker base URL (default: ws://127.0.0.1:4180)
    ALLOWLISTER_REMOTE_BROKER_CA     PEM CA bundle to trust for wss://
    RUST_LOG                         log filter, e.g. info, debug (default: info)

OPTIONS:
    -h, --help       Print this help and exit
    -V, --version    Print the version and exit";

/// Daemon version reported by `--version`. Release builds inject the published
/// version from the git tag via `ALLOWLISTER_REMOTE_PLUGIN_VERSION` (see
/// `publish.yml`), mirroring how the plugin binary and npm packages are stamped
/// from the same tag; dev and test builds fall back to the crate's `Cargo.toml`
/// version so local runs report a stable value.
const VERSION: &str = match option_env!("ALLOWLISTER_REMOTE_PLUGIN_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};

#[tokio::main]
async fn main() {
    if std::env::args().any(|argument| argument == "--help" || argument == "-h") {
        println!("{HELP}");
        return;
    }
    if std::env::args().any(|argument| argument == "--version" || argument == "-V") {
        println!("{VERSION}");
        return;
    }

    init_tracing();

    let socket_path =
        std::env::var("ALLOWLISTER_REMOTE_DAEMON_SOCK").unwrap_or_else(|_| default_socket_path());
    let broker_url = default_broker_url();
    let ca_path = std::env::var("ALLOWLISTER_REMOTE_BROKER_CA")
        .ok()
        .filter(|value| !value.is_empty());

    if let Err(error) = serve(Config {
        socket_path,
        broker_url,
        ca_path,
    })
    .await
    {
        tracing::error!(%error, "allowlister-remote-daemon exited");
        std::process::exit(1);
    }
}

/// Install a `RUST_LOG`-driven log subscriber writing to stderr, defaulting to
/// `info` when `RUST_LOG` is unset. Off-by-default verbosity beyond that keeps a
/// resident daemon quiet while making the broker link observable on demand —
/// `RUST_LOG=debug` traces every connect, reconnect, and routed decision. The
/// daemon was previously silent, which made the broker link impossible to triage
/// from the outside (see issue #93). `try_init` so a test that already installed a
/// subscriber does not panic.
fn init_tracing() {
    use tracing_subscriber::{fmt, EnvFilter};
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .try_init();
}
