use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;
use std::io::{self, Read};
use std::process;
use std::thread::sleep;
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

fn main() {
    let server_url = arg(
        "--server-url",
        &env::var("ALLOWLISTER_REMOTE_URL").unwrap_or_else(|_| "http://127.0.0.1:3000".to_string()),
    )
    .trim_end_matches('/')
    .to_string();
    let timeout_ms: u64 = arg("--timeout-ms", "120000").parse().unwrap_or(120000);
    let poll_ms: u64 = arg("--poll-ms", "150").parse().unwrap_or(150);

    let mut stdin = String::new();
    io::stdin()
        .read_to_string(&mut stdin)
        .expect("read allowlister plugin stdin");
    let input: Value = serde_json::from_str(&stdin).expect("parse allowlister plugin JSON");

    if let Some(verdict) = input.get("current_verdict").and_then(Value::as_str) {
        if verdict != "defer" && verdict != "ask" {
            write_response(
                "defer",
                "static allowlister verdict does not need remote approval",
            );
        }
    }

    let client = Client::builder()
        .user_agent("allowlister-remote-plugin/0.1")
        .no_proxy()
        .timeout(Duration::from_millis(timeout_ms.min(30_000)))
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

    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    while Instant::now() < deadline {
        let result = client
            .get(format!(
                "{server_url}/api/plugin/requests/{}/decision",
                create.id
            ))
            .send();
        if let Ok(response) = result {
            if response.status().as_u16() == 200 {
                let decision: PendingOrDecision = response.json().unwrap_or_else(|error| {
                    write_response("ask", format!("invalid remote decision: {error}"))
                });
                if decision.status.as_deref() != Some("pending") {
                    let verdict = match decision.verdict.as_deref() {
                        Some("deny") => "deny",
                        _ => "allow",
                    };
                    write_response(
                        verdict,
                        decision
                            .reason
                            .unwrap_or_else(|| format!("remote {verdict}")),
                    );
                }
            }
        }
        sleep(Duration::from_millis(poll_ms));
    }

    write_response(
        "ask",
        format!("allowlister-remote timed out after {timeout_ms}ms"),
    );
}
