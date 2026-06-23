use allowlister_remote_plugin::{
    build_create_body, local_prompt, parse_local_input, request_summary, static_decision,
    FlaggedFragment, LocalDecision,
};

// The plugin always reaches the broker through the host daemon, over a Unix
// socket on Unix and a named pipe on Windows (see `daemon.rs`); there is no
// direct-to-server path.
mod daemon;
use serde::Serialize;
use serde_json::Value;
use std::env;
use std::fs::OpenOptions;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::process;
use std::sync::mpsc::{self, Receiver};
use std::thread;

#[derive(Debug, Serialize)]
struct PluginResponse<'a> {
    verdict: &'a str,
    reason: String,
}

/// Look up a `--name value` flag in a pre-collected argument list. The args are
/// collected once by the caller (only on the approval path) so the flag lookups
/// do not each re-walk and re-clone `env::args`.
fn arg(args: &[String], name: &str, fallback: &str) -> String {
    args.windows(2)
        .find_map(|pair| (pair[0] == name).then(|| pair[1].clone()))
        .unwrap_or_else(|| fallback.to_string())
}

fn write_response(verdict: &str, reason: impl Into<String>) -> ! {
    let response = PluginResponse {
        verdict,
        reason: reason.into(),
    };
    print!(
        "{}",
        serde_json::to_string(&response).expect("plugin response serializes")
    );
    process::exit(0);
}

/// Start a local approval prompt on the controlling terminal, returning a
/// channel that yields the operator's decision and a writer for status
/// updates. When there is no terminal (CI, piped stdio, Windows console),
/// both are `None` and the plugin waits on the remote decision alone.
fn start_local_prompt(
    command: &str,
    cwd: &str,
    flagged: &[FlaggedFragment],
    tool_input: Option<&str>,
) -> (Option<Receiver<LocalDecision>>, Option<impl Write>) {
    let Ok(tty) = OpenOptions::new().read(true).write(true).open("/dev/tty") else {
        return (None, None);
    };
    let (Ok(mut prompt_writer), Ok(status_writer)) = (tty.try_clone(), tty.try_clone()) else {
        return (None, None);
    };

    let _ = writeln!(
        prompt_writer,
        "{}",
        local_prompt(command, cwd, flagged, tool_input)
    );

    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let reader = BufReader::new(tty);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            match parse_local_input(&line) {
                Some(decision) => {
                    let _ = tx.send(decision);
                    break;
                }
                None => {
                    let _ = writeln!(prompt_writer, "Please type 'a' to allow or 'd' to deny: ");
                }
            }
        }
    });

    (Some(rx), Some(status_writer))
}

/// Plugin version reported by `--version`. Release
/// builds inject the published version from the git tag via
/// `ALLOWLISTER_REMOTE_PLUGIN_VERSION` (see `publish.yml`), mirroring how the npm
/// packages are stamped from the tag; dev and test builds fall back to the
/// crate's `Cargo.toml` version so local runs and `cargo test` report a stable
/// value.
const VERSION: &str = match option_env!("ALLOWLISTER_REMOTE_PLUGIN_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};

fn main() {
    if env::args().any(|argument| argument == "--version" || argument == "-V") {
        println!("{VERSION}");
        return;
    }

    let mut stdin = String::new();
    io::stdin()
        .read_to_string(&mut stdin)
        .expect("read allowlister plugin stdin");

    // Hot path: a static allow/deny verdict settles the command without remote
    // approval. Probe `current_verdict` alone — no full `Value` tree, no arg
    // collection — and exit before any of the request-opening setup below.
    if static_decision(&stdin) == Some(true) {
        write_response(
            "defer",
            "static allowlister verdict does not need remote approval",
        );
    }

    // Non-static (or unparseable): now do the full parse, which also surfaces a
    // precise error for a malformed payload.
    let input: Value = serde_json::from_str(&stdin).unwrap_or_else(|error| {
        write_response("ask", format!("invalid allowlister plugin input: {error}"))
    });

    // Only the approval path reads CLI flags, so collect args once here rather
    // than on every (mostly static) invocation. The plugin reaches the broker
    // exclusively through the host daemon: it connects over local IPC (a Unix
    // socket or a Windows named pipe), auto-starting the daemon if none is
    // listening, and hands off the request. The daemon owns the one upstream
    // WebSocket to the broker (which may live on another machine) and relays the
    // decision back.
    let args: Vec<String> = env::args().collect();
    let broker_url = arg(
        &args,
        "--broker-url",
        &env::var("ALLOWLISTER_REMOTE_BROKER_URL").unwrap_or_default(),
    );
    let configured_socket = arg(
        &args,
        "--daemon-socket",
        &env::var("ALLOWLISTER_REMOTE_DAEMON_SOCK").unwrap_or_default(),
    );
    let socket_path = if configured_socket.is_empty() {
        daemon::default_socket_path()
    } else {
        configured_socket
    };
    let config = daemon::DaemonConfig {
        socket_path,
        daemon_bin: env::var("ALLOWLISTER_REMOTE_DAEMON_BIN")
            .ok()
            .filter(|value| !value.is_empty()),
        broker_url: (!broker_url.is_empty()).then(|| broker_url.clone()),
    };

    match daemon::connect_or_start(&config) {
        Some(stream) => {
            // For a shell payload this names the command; for a tool call, the
            // tool — so the local prompt always names the action awaiting approval.
            let summary = request_summary(&input);
            let cwd = input
                .get("cwd")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            daemon::run_via_daemon(stream, build_create_body(&input), &summary, &cwd);
        }
        // No daemon and we could not start one: there is no other transport, so
        // surface it as `ask` rather than blocking forever or guessing a verdict.
        None => write_response(
            "ask",
            "allowlister-remote daemon unavailable: could not open the approval channel",
        ),
    }
}
