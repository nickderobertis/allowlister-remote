//! Pure, network-free decision helpers for the allowlister-remote plugin.
//!
//! The binary (`src/main.rs`) is mostly I/O: it reads a harness payload on
//! stdin, opens an approval request over HTTP, then races a local-terminal
//! prompt against the server's verdict. The work that is *not* I/O — parsing
//! the incoming payload, deciding whether a static verdict short-circuits the
//! remote round-trip, building the create-request body, and interpreting a
//! decision response — lives here so it can be unit-tested and benchmarked
//! (`benches/engine.rs`) without spawning a process or opening a socket.

use serde::Deserialize;
use serde_json::{json, Value};

/// A decision captured from the operator at the local terminal.
pub struct LocalDecision {
    pub verdict: &'static str,
    pub reason: String,
}

/// Map a line typed at the terminal onto an allow/deny verdict, ignoring
/// anything we do not recognize so the operator can simply retry.
pub fn parse_local_input(line: &str) -> Option<LocalDecision> {
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

/// Whether the harness already settled this command with a static allow/deny
/// verdict, so no remote approval is needed. Only `defer`/`ask` (or a missing
/// verdict) reach the server.
pub fn is_static_decision(input: &Value) -> bool {
    matches!(
        input.get("current_verdict").and_then(Value::as_str),
        Some(verdict) if verdict != "defer" && verdict != "ask"
    )
}

/// Build the JSON body POSTed to open an approval request. allowlister's
/// protocol-v2 payload is forwarded verbatim — `protocol_version`, `subject`,
/// `command`, `fragments`, `tool`, and the pre-plugin verdict/reason — so the
/// server records the real structured decomposition instead of re-deriving it,
/// and the app's own `timeoutMs` is layered on top.
pub fn build_create_body(input: &Value, timeout_ms: u64) -> Value {
    let mut body = match input {
        Value::Object(_) => input.clone(),
        _ => Value::Object(serde_json::Map::new()),
    };
    if let Value::Object(map) = &mut body {
        map.insert("timeoutMs".to_string(), json!(timeout_ms));
    }
    body
}

/// A short human label for the local-terminal prompt: the shell command when
/// present, otherwise the tool name for a non-shell tool call, otherwise empty.
pub fn request_summary(input: &Value) -> String {
    if let Some(command) = input.get("command").and_then(Value::as_str) {
        if !command.is_empty() {
            return command.to_string();
        }
    }
    input
        .get("tool")
        .and_then(|tool| tool.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

/// Outcome of [`triage`].
#[derive(Debug, PartialEq)]
pub enum Triage {
    /// A static verdict settled it; defer to allowlister without a round-trip.
    Defer,
    /// Needs remote approval; carries the body to POST to `/api/plugin/requests`.
    NeedsApproval(Value),
}

/// The pre-network pipeline: parse a harness payload, then either short-circuit
/// a static verdict or produce the create-request body to POST. Mirrors the
/// composition the binary runs before it touches the network, so the benches
/// track the real per-invocation cost.
pub fn triage(stdin: &str, timeout_ms: u64) -> Result<Triage, serde_json::Error> {
    let input: Value = serde_json::from_str(stdin)?;
    if is_static_decision(&input) {
        Ok(Triage::Defer)
    } else {
        Ok(Triage::NeedsApproval(build_create_body(&input, timeout_ms)))
    }
}

#[derive(Debug, Deserialize)]
struct PendingOrDecision {
    status: Option<String>,
    verdict: Option<String>,
    reason: Option<String>,
}

/// A poll response interpreted from the server's decision endpoint.
#[derive(Debug, PartialEq)]
pub enum RemoteDecision {
    /// The server is still waiting on a human; keep polling.
    Pending,
    /// A human decided. `verdict` is normalized to `allow`/`deny`.
    Decided {
        verdict: &'static str,
        reason: String,
    },
    /// The body did not parse as a decision; the caller falls back to `ask`.
    Invalid(String),
}

/// Interpret a poll response body. Any verdict other than `deny` is treated as
/// `allow` (the server only ever sends `allow`/`deny`), and a parse failure is
/// reported so the caller can fall back to `ask` rather than block forever.
pub fn interpret_decision(body: &str) -> RemoteDecision {
    let decision: PendingOrDecision = match serde_json::from_str(body) {
        Ok(decision) => decision,
        Err(error) => return RemoteDecision::Invalid(format!("invalid remote decision: {error}")),
    };
    if decision.status.as_deref() == Some("pending") {
        return RemoteDecision::Pending;
    }
    let verdict = match decision.verdict.as_deref() {
        Some("deny") => "deny",
        _ => "allow",
    };
    RemoteDecision::Decided {
        verdict,
        reason: decision
            .reason
            .unwrap_or_else(|| format!("remote {verdict}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_input_maps_synonyms_and_ignores_noise() {
        assert_eq!(parse_local_input(" Allow ").unwrap().verdict, "allow");
        assert_eq!(parse_local_input("y").unwrap().verdict, "allow");
        assert_eq!(parse_local_input("DENY").unwrap().verdict, "deny");
        assert_eq!(parse_local_input("n").unwrap().verdict, "deny");
        assert!(parse_local_input("maybe").is_none());
    }

    #[test]
    fn static_allow_defers_but_defer_and_ask_reach_server() {
        // A protocol-v2 shell payload: the create body forwards the structured
        // fragments verbatim, not just the flat command/verdict fields.
        let body = r#"{"protocol_version":2,"subject":"shell","current_verdict":"defer","command":"gh pr merge 42","fragments":[{"display":"gh pr merge 42","verdict":"defer","role":"standalone","rule":null}]}"#;
        match triage(body, 0).expect("valid payload") {
            Triage::NeedsApproval(create) => {
                assert_eq!(create["command"], "gh pr merge 42");
                assert_eq!(create["timeoutMs"], 0);
                assert_eq!(create["subject"], "shell");
                assert_eq!(create["protocol_version"], 2);
                assert_eq!(create["fragments"][0]["display"], "gh pr merge 42");
            }
            Triage::Defer => panic!("defer verdict must reach the server"),
        }
        assert_eq!(
            triage(r#"{"current_verdict":"allow"}"#, 0).expect("valid"),
            Triage::Defer
        );
        assert!(matches!(
            triage(r#"{"current_verdict":"ask"}"#, 0).expect("valid"),
            Triage::NeedsApproval(_)
        ));
    }

    #[test]
    fn create_body_forwards_tool_calls_verbatim() {
        let body = r#"{"protocol_version":2,"subject":"tool","current_verdict":"defer","tool":{"name":"mcp__github__create_issue","capability":"mcp","params":{},"raw":{"repo":"app"}}}"#;
        let input: Value = serde_json::from_str(body).expect("valid");
        let create = build_create_body(&input, 5000);
        assert_eq!(create["subject"], "tool");
        assert_eq!(create["tool"]["name"], "mcp__github__create_issue");
        assert_eq!(create["tool"]["raw"]["repo"], "app");
        assert_eq!(create["timeoutMs"], 5000);
        // A non-object payload degrades to just the timeout rather than panicking.
        assert_eq!(build_create_body(&Value::Null, 1)["timeoutMs"], 1);
    }

    #[test]
    fn request_summary_prefers_command_then_tool_name() {
        assert_eq!(
            request_summary(&serde_json::json!({"command":"npm test"})),
            "npm test"
        );
        assert_eq!(
            request_summary(&serde_json::json!({"command":"","tool":{"name":"write"}})),
            "write"
        );
        assert_eq!(request_summary(&serde_json::json!({})), "");
    }

    #[test]
    fn triage_surfaces_invalid_json() {
        assert!(triage("not json", 0).is_err());
    }

    #[test]
    fn decision_pending_then_allow_deny_and_invalid() {
        assert_eq!(
            interpret_decision(r#"{"status":"pending"}"#),
            RemoteDecision::Pending
        );
        assert_eq!(
            interpret_decision(r#"{"verdict":"deny","reason":"nope"}"#),
            RemoteDecision::Decided {
                verdict: "deny",
                reason: "nope".to_string()
            }
        );
        // Missing reason falls back to a synthesized one; unknown verdict allows.
        assert_eq!(
            interpret_decision(r#"{"verdict":"whatever"}"#),
            RemoteDecision::Decided {
                verdict: "allow",
                reason: "remote allow".to_string()
            }
        );
        assert!(matches!(
            interpret_decision("{not json"),
            RemoteDecision::Invalid(_)
        ));
    }
}
