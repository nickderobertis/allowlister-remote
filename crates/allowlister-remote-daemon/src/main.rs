//! Binary entry point for the allowlister-remote daemon. Reads the socket path
//! and broker URL from the environment (with sensible per-user defaults) and
//! serves until interrupted. The plugin auto-starts this binary when no daemon
//! is already listening.

use allowlister_remote_daemon::{default_broker_url, default_socket_path, serve, Config};

#[tokio::main]
async fn main() {
    let socket_path =
        std::env::var("ALLOWLISTER_REMOTE_DAEMON_SOCK").unwrap_or_else(|_| default_socket_path());
    let broker_url = default_broker_url();

    if let Err(error) = serve(Config {
        socket_path,
        broker_url,
    })
    .await
    {
        eprintln!("allowlister-remote-daemon exited: {error}");
        std::process::exit(1);
    }
}
