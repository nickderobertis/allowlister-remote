use allowlister_remote_plugin::{
    build_create_body, flagged_fragments, interpret_decision, local_prompt, parse_local_input,
    request_summary, static_decision, tool_input_json, FlaggedFragment, LocalDecision,
    RemoteDecision,
};

// Daemon mode is built on Unix domain sockets, so it is Unix-only; Windows uses
// the HTTP path exclusively.
#[cfg(unix)]
mod daemon;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;
use std::fs::OpenOptions;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::process;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::Duration;

#[derive(Debug, Deserialize)]
struct CreateResponse {
    id: String,
}

#[derive(Debug, Serialize)]
struct PluginResponse<'a> {
    verdict: &'a str,
    reason: String,
}

/// Look up a `--name value` flag in a pre-collected argument list. The args are
/// collected once by the caller (only on the network path) so the three flag
/// lookups do not each re-walk and re-clone `env::args`.
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

/// Poll the remote server once for a decision. Returns `Some` only when the
/// browser has allowed or denied the request.
fn poll_remote(client: &Client, server_url: &str, id: &str) -> Option<(&'static str, String)> {
    let response = client
        .get(format!("{server_url}/api/plugin/requests/{id}/decision"))
        .send()
        .ok()?;
    if response.status().as_u16() != 200 {
        return None;
    }
    // A read error here is transport noise, not a decision; keep polling.
    let body = response.text().ok()?;
    match interpret_decision(&body) {
        RemoteDecision::Pending => None,
        RemoteDecision::Decided { verdict, reason } => Some((verdict, reason)),
        RemoteDecision::Invalid(message) => write_response("ask", message),
    }
}

/// Record a local decision with the server so the pending web approval is
/// dismissed for anyone watching the app.
fn submit_local_decision(client: &Client, server_url: &str, id: &str, decision: &LocalDecision) {
    let _ = client
        .post(format!("{server_url}/api/approval-requests/{id}/decision"))
        .json(&json!({ "verdict": decision.verdict, "reason": decision.reason }))
        .send();
}

/// Plugin version reported by `--version` and the HTTP user-agent. Release
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

    // Only the network path reads CLI flags, so collect args once here rather
    // than on every (mostly static) invocation.
    let args: Vec<String> = env::args().collect();
    let server_url = arg(
        &args,
        "--server-url",
        &env::var("ALLOWLISTER_REMOTE_URL").unwrap_or_else(|_| "http://127.0.0.1:3000".to_string()),
    )
    .trim_end_matches('/')
    .to_string();
    let poll_ms: u64 = arg(&args, "--poll-ms", "150").parse().unwrap_or(150);

    // Daemon mode (opt-in, Unix only): when a broker URL or daemon socket is
    // configured, or `--use-daemon` is passed, route through the host daemon —
    // auto-starting it if needed — instead of polling the server directly. It is
    // built on Unix domain sockets, so Windows always uses the HTTP path below.
    // If the daemon cannot be reached, fall through to the direct HTTP path too.
    #[cfg(unix)]
    {
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
        let use_daemon = args.iter().any(|argument| argument == "--use-daemon")
            || !broker_url.is_empty()
            || !configured_socket.is_empty();
        if use_daemon {
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
            if let Some(stream) = daemon::connect_or_start(&config) {
                let summary = request_summary(&input);
                let cwd = input
                    .get("cwd")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                daemon::run_via_daemon(stream, build_create_body(&input), &summary, &cwd);
            }
            // Daemon unreachable: fall through to the direct HTTP path.
        }
    }

    let client = Client::builder()
        .user_agent(format!("allowlister-remote-plugin/{VERSION}"))
        .no_proxy()
        .timeout(Duration::from_secs(30))
        .build()
        .expect("build HTTP client");
    let create: CreateResponse = client
        .post(format!("{server_url}/api/plugin/requests"))
        .json(&build_create_body(&input))
        .send()
        .and_then(|response| response.error_for_status())
        .and_then(|response| response.json())
        .unwrap_or_else(|error| {
            write_response(
                "ask",
                format!("allowlister-remote server unavailable: {error}"),
            )
        });

    // For a shell payload this is the command; for a tool call it is the tool
    // name, so the local prompt always names the action awaiting approval.
    let summary = request_summary(&input);
    let flagged = flagged_fragments(&input);
    let tool_input = tool_input_json(&input);
    let cwd = input.get("cwd").and_then(Value::as_str).unwrap_or("");
    let (mut local_rx, mut status_writer) =
        start_local_prompt(&summary, cwd, &flagged, tool_input.as_deref());

    let poll_interval = Duration::from_millis(poll_ms);

    loop {
        if let Some((verdict, reason)) = poll_remote(&client, &server_url, &create.id) {
            if let Some(writer) = status_writer.as_mut() {
                let _ = writeln!(writer, "\nResolved remotely: {verdict}.");
            }
            write_response(verdict, reason);
        }

        match local_rx.as_ref().map(|rx| rx.recv_timeout(poll_interval)) {
            Some(Ok(decision)) => {
                submit_local_decision(&client, &server_url, &create.id, &decision);
                write_response(decision.verdict, decision.reason);
            }
            // The terminal closed without a decision; keep waiting on the web.
            Some(Err(RecvTimeoutError::Disconnected)) => local_rx = None,
            // No local terminal, or just nothing typed this interval.
            None => thread::sleep(poll_interval),
            Some(Err(RecvTimeoutError::Timeout)) => {}
        }
    }
}
