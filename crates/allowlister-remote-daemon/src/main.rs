//! Binary entry point for the allowlister-remote daemon. Reads the socket path
//! and broker URL from the environment (with sensible per-user defaults) and
//! serves until interrupted. The plugin auto-starts this binary when no daemon
//! is already listening.

use allowlister_remote_daemon::{default_broker_url, default_socket_path, serve, Config};

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
    if std::env::args().any(|argument| argument == "--version" || argument == "-V") {
        println!("{VERSION}");
        return;
    }

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
        eprintln!("allowlister-remote-daemon exited: {error}");
        std::process::exit(1);
    }
}
