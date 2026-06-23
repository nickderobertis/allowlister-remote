//! Plugin-side daemon client (binary-only; kept out of `lib.rs` so the pure
//! decision helpers stay network-free).
//!
//! The plugin always talks to the host daemon, never to the broker or a server
//! directly. It connects over a local IPC channel — a Unix-domain socket on
//! Unix, a named pipe on Windows — auto-starting the daemon if none is
//! listening, hands off the approval request, then races the local `/dev/tty`
//! prompt against the decision the daemon relays from the broker. This keeps the
//! long upstream WebSocket in the daemon (one per host, often dialing a broker on
//! another machine) instead of opening one per gated command.

use allowlister_remote_plugin::{
    flagged_fragments, interpret_decision, tool_input_json, RemoteDecision,
};
use serde_json::{json, Value};
use std::env;
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::net::UnixStream;

/// The local IPC stream to the daemon. Both backends are blocking and implement
/// `Read + Write` plus `try_clone`, which is all the newline-delimited JSON
/// protocol needs: a Unix-domain socket on Unix, and a named pipe opened as a
/// file handle on Windows (a connected named-pipe client behaves like a file).
#[cfg(unix)]
pub type LocalStream = UnixStream;
#[cfg(windows)]
pub type LocalStream = std::fs::File;

pub struct DaemonConfig {
    pub socket_path: String,
    pub daemon_bin: Option<String>,
    pub broker_url: Option<String>,
}

/// Default local IPC address; mirrors the daemon's own default so the plugin and
/// an independently-started daemon meet at the same place. Per-user under
/// `$XDG_RUNTIME_DIR` on Unix; a per-user named pipe on Windows.
#[cfg(unix)]
pub fn default_socket_path() -> String {
    if let Ok(dir) = env::var("XDG_RUNTIME_DIR") {
        if !dir.is_empty() {
            return format!("{dir}/allowlister-remote-daemon.sock");
        }
    }
    format!(
        "/tmp/allowlister-remote-daemon-{}.sock",
        env::var("UID").unwrap_or_else(|_| "0".into())
    )
}

#[cfg(windows)]
pub fn default_socket_path() -> String {
    let user = env::var("USERNAME").unwrap_or_else(|_| "default".into());
    format!(r"\\.\pipe\allowlister-remote-daemon-{user}")
}

/// Open a blocking connection to the daemon's local IPC address.
#[cfg(unix)]
fn connect(path: &str) -> std::io::Result<LocalStream> {
    UnixStream::connect(path)
}

#[cfg(windows)]
fn connect(path: &str) -> std::io::Result<LocalStream> {
    // A named-pipe client connects by opening the pipe path for read+write; the
    // handle then reads and writes like any file.
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
}

/// Connect to the daemon, auto-starting it if nothing is listening yet. Returns
/// `None` if it still cannot be reached, so the caller settles the request with
/// `ask` (there is no other transport to fall back to).
pub fn connect_or_start(config: &DaemonConfig) -> Option<LocalStream> {
    if let Ok(stream) = connect(&config.socket_path) {
        return Some(stream);
    }
    // Nothing listening: start a daemon (it may lose a bind race with another
    // plugin starting concurrently — that is fine, we just connect to the winner).
    spawn_daemon(config);

    let wait_ms = env::var("ALLOWLISTER_REMOTE_DAEMON_WAIT_MS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(2000);
    let deadline = Instant::now() + Duration::from_millis(wait_ms);
    while Instant::now() < deadline {
        if let Ok(stream) = connect(&config.socket_path) {
            return Some(stream);
        }
        thread::sleep(Duration::from_millis(20));
    }
    None
}

/// Spawn the daemon detached so a Ctrl-C to the gated command's group does not
/// also kill it, and with null stdio so it does not hold the plugin's pipes open.
fn spawn_daemon(config: &DaemonConfig) {
    let mut command = Command::new(resolve_daemon_bin(config));
    command.env("ALLOWLISTER_REMOTE_DAEMON_SOCK", &config.socket_path);
    if let Some(url) = &config.broker_url {
        command.env("ALLOWLISTER_REMOTE_BROKER_URL", url);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        // Its own process group, so a Ctrl-C to the command's group spares it.
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP: no inherited console and
        // its own group, the Windows equivalent of a detached process group.
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    let _ = command.spawn();
}

/// Resolve the daemon binary: explicit override, else a sibling of this plugin
/// binary (how the npm package ships them together), else the bare name on PATH.
fn resolve_daemon_bin(config: &DaemonConfig) -> String {
    if let Some(bin) = &config.daemon_bin {
        return bin.clone();
    }
    let exe_name = format!("allowlister-remote-daemon{}", env::consts::EXE_SUFFIX);
    if let Ok(exe) = env::current_exe() {
        if let Some(sibling) = exe.parent().map(|dir| dir.join(&exe_name)) {
            if sibling.exists() {
                return sibling.to_string_lossy().into_owned();
            }
        }
    }
    exe_name
}

/// A decision reaching the plugin's main loop, from either side of the race.
enum Event {
    Remote {
        verdict: &'static str,
        reason: String,
    },
    Local {
        verdict: &'static str,
        reason: String,
    },
    Ack,
    Closed,
}

/// Run the approval exchange over the daemon connection. Diverges: it always
/// exits the process via `write_response`.
pub fn run_via_daemon(stream: LocalStream, create_body: Value, summary: &str, cwd: &str) -> ! {
    let mut writer = stream.try_clone().expect("clone daemon connection");
    let reader = BufReader::new(stream);

    let _ = writeln!(
        writer,
        "{}",
        json!({ "type": "create", "payload": create_body })
    );
    let _ = writer.flush();

    let (tx, rx) = mpsc::channel::<Event>();

    // The local `/dev/tty` prompt feeds the same channel as the daemon socket.
    // It shows the same flagged fragments + full command (and, for a tool call,
    // the same formatted JSON input) as the web app; the create body is the
    // forwarded payload, so the fragments and tool input come straight off it.
    let flagged = flagged_fragments(&create_body);
    let tool_input = tool_input_json(&create_body);
    let (local_rx, _status) =
        crate::start_local_prompt(summary, cwd, &flagged, tool_input.as_deref());
    if let Some(local_rx) = local_rx {
        let tx_local = tx.clone();
        thread::spawn(move || {
            while let Ok(decision) = local_rx.recv() {
                if tx_local
                    .send(Event::Local {
                        verdict: decision.verdict,
                        reason: decision.reason,
                    })
                    .is_err()
                {
                    break;
                }
            }
        });
    }

    // Decisions/acks the daemon relays from the broker.
    let tx_remote = tx.clone();
    thread::spawn(move || {
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            match value.get("type").and_then(Value::as_str) {
                Some("ack") => {
                    let _ = tx_remote.send(Event::Ack);
                }
                Some("decision") => {
                    if let RemoteDecision::Decided { verdict, reason } = interpret_decision(&line) {
                        let _ = tx_remote.send(Event::Remote { verdict, reason });
                    }
                }
                _ => {}
            }
        }
        let _ = tx_remote.send(Event::Closed);
    });

    loop {
        match rx.recv() {
            Ok(Event::Remote { verdict, reason }) => crate::write_response(verdict, reason),
            Ok(Event::Local { verdict, reason }) => {
                let _ = writeln!(
                    writer,
                    "{}",
                    json!({ "type": "decision", "verdict": verdict, "reason": reason })
                );
                let _ = writer.flush();
                // Wait briefly for the daemon's ack so the broker has dismissed the
                // web prompt before we exit, then settle with the local verdict.
                let _ = rx.recv_timeout(Duration::from_secs(2));
                crate::write_response(verdict, reason);
            }
            Ok(Event::Ack) => {}
            Ok(Event::Closed) | Err(_) => {
                crate::write_response("ask", "allowlister-remote daemon closed the connection")
            }
        }
    }
}
