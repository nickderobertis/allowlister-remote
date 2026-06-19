use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;
use std::fs::OpenOptions;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::process;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug, Deserialize)]
struct CreateResponse {
    id: String,
}

#[derive(Debug, Deserialize)]
struct PendingOrDecision {
    status: Option<String>,
    verdict: Option<String>,
    reason: Option<String>,
}

#[derive(Debug, Serialize)]
struct PluginResponse<'a> {
    verdict: &'a str,
    reason: String,
}

/// A decision captured from the operator at the local terminal.
struct LocalDecision {
    verdict: &'static str,
    reason: String,
}

fn arg(name: &str, fallback: &str) -> String {
    let args: Vec<String> = env::args().collect();
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

/// Map a line typed at the terminal onto an allow/deny verdict, ignoring
/// anything we do not recognize so the operator can simply retry.
fn parse_local_input(line: &str) -> Option<LocalDecision> {
    match line.trim().to_ascii_lowercase().as_str() {
        "a" | "allow" | "y" | "yes" => Some(LocalDecision {
            verdict: "allow",
            reason: "approved at local terminal".to_string(),
        }),
        "d" | "deny" | "n" | "no" => Some(LocalDecision {
            verdict: "deny",
            reason: "denied at local terminal".to_string(),
        }),
        _ => None,
    }
}

/// Start a local approval prompt on the controlling terminal, returning a
/// channel that yields the operator's decision and a writer for status
/// updates. When there is no terminal (CI, piped stdio, Windows console),
/// both are `None` and the plugin waits on the remote decision alone.
fn start_local_prompt(
    command: &str,
    cwd: &str,
) -> (Option<Receiver<LocalDecision>>, Option<impl Write>) {
    let Ok(tty) = OpenOptions::new().read(true).write(true).open("/dev/tty") else {
        return (None, None);
    };
    let (Ok(mut prompt_writer), Ok(status_writer)) = (tty.try_clone(), tty.try_clone()) else {
        return (None, None);
    };

    let _ = writeln!(
        prompt_writer,
        "\nallowlister-remote approval required\n  command: {command}\n  cwd: {cwd}\nApprove here or in the web app. [a]llow / [d]eny: "
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
    let decision: PendingOrDecision = response
        .json()
        .unwrap_or_else(|error| write_response("ask", format!("invalid remote decision: {error}")));
    if decision.status.as_deref() == Some("pending") {
        return None;
    }
    let verdict = match decision.verdict.as_deref() {
        Some("deny") => "deny",
        _ => "allow",
    };
    Some((
        verdict,
        decision
            .reason
            .unwrap_or_else(|| format!("remote {verdict}")),
    ))
}

/// Record a local decision with the server so the pending web approval is
/// dismissed for anyone watching the app.
fn submit_local_decision(client: &Client, server_url: &str, id: &str, decision: &LocalDecision) {
    let _ = client
        .post(format!("{server_url}/api/approval-requests/{id}/decision"))
        .json(&json!({ "verdict": decision.verdict, "reason": decision.reason }))
        .send();
}

fn main() {
    if env::args().any(|argument| argument == "--version" || argument == "-V") {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return;
    }

    let server_url = arg(
        "--server-url",
        &env::var("ALLOWLISTER_REMOTE_URL").unwrap_or_else(|_| "http://127.0.0.1:3000".to_string()),
    )
    .trim_end_matches('/')
    .to_string();
    // A timeout of 0 (the default) means wait indefinitely for a decision from
    // either the local terminal or the web app.
    let timeout_ms: u64 = arg("--timeout-ms", "0").parse().unwrap_or(0);
    let poll_ms: u64 = arg("--poll-ms", "150").parse().unwrap_or(150);

    let mut stdin = String::new();
    io::stdin()
        .read_to_string(&mut stdin)
        .expect("read allowlister plugin stdin");
    let input: Value = serde_json::from_str(&stdin).unwrap_or_else(|error| {
        write_response("ask", format!("invalid allowlister plugin input: {error}"))
    });

    if let Some(verdict) = input.get("current_verdict").and_then(Value::as_str) {
        if verdict != "defer" && verdict != "ask" {
            write_response(
                "defer",
                "static allowlister verdict does not need remote approval",
            );
        }
    }

    let client = Client::builder()
        .user_agent(concat!(
            "allowlister-remote-plugin/",
            env!("CARGO_PKG_VERSION")
        ))
        .no_proxy()
        .timeout(Duration::from_secs(30))
        .build()
        .expect("build HTTP client");
    let create: CreateResponse = client
        .post(format!("{server_url}/api/plugin/requests"))
        .json(&json!({
            "command": input.get("command").cloned().unwrap_or(Value::Null),
            "cwd": input.get("cwd").cloned().unwrap_or(Value::Null),
            "harness": input.get("harness").cloned().unwrap_or(Value::Null),
            "current_verdict": input.get("current_verdict").cloned().unwrap_or(Value::Null),
            "current_reason": input.get("current_reason").cloned().unwrap_or(Value::Null),
            "timeoutMs": timeout_ms,
        }))
        .send()
        .and_then(|response| response.error_for_status())
        .and_then(|response| response.json())
        .unwrap_or_else(|error| {
            write_response(
                "ask",
                format!("allowlister-remote server unavailable: {error}"),
            )
        });

    let command = input.get("command").and_then(Value::as_str).unwrap_or("");
    let cwd = input.get("cwd").and_then(Value::as_str).unwrap_or("");
    let (mut local_rx, mut status_writer) = start_local_prompt(command, cwd);

    // A zero timeout waits indefinitely; a positive timeout keeps the legacy
    // bounded behavior for callers that opt into it.
    let deadline = (timeout_ms > 0).then(|| Instant::now() + Duration::from_millis(timeout_ms));
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

        if let Some(deadline) = deadline {
            if Instant::now() >= deadline {
                write_response(
                    "ask",
                    format!("allowlister-remote timed out after {timeout_ms}ms"),
                );
            }
        }
    }
}
