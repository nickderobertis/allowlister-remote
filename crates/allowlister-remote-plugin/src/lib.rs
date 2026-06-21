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
use serde_json::Value;

/// A decision captured from the operator at the local terminal.
pub struct LocalDecision {
    pub verdict: &'static str,
    pub reason: String,
}

/// The exact text the plugin writes to `/dev/tty` to open a local approval
/// prompt: the awaiting command (or tool name) and its cwd, then the
/// allow/deny instruction. Extracted here as a pure function so the binary's
/// real terminal surface is unit-testable and so the visual-docs capture can
/// render the genuine prompt from a fixture pinned to this output (see
/// `apps/web/screenshots/terminal.capture.ts`). The caller appends the trailing
/// newline (`writeln!`), so this returns the line block without it.
pub fn local_prompt(command: &str, cwd: &str) -> String {
    format!(
        "\nallowlister-remote approval required\n  command: {command}\n  cwd: {cwd}\nApprove here or in the web app. [a]llow / [d]eny: "
    )
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

/// The shared predicate behind [`is_static_decision`] and [`static_decision`]:
/// a present verdict that is neither `defer` nor `ask` settled the command, so
/// only those two (or a missing verdict) reach the server.
fn is_static_verdict(verdict: Option<&str>) -> bool {
    matches!(verdict, Some(v) if v != "defer" && v != "ask")
}

/// Whether the harness already settled this command with a static allow/deny
/// verdict, so no remote approval is needed. Only `defer`/`ask` (or a missing
/// verdict) reach the server.
pub fn is_static_decision(input: &Value) -> bool {
    is_static_verdict(input.get("current_verdict").and_then(Value::as_str))
}

/// A zero-copy probe over the harness payload that reads only `current_verdict`
/// and skips every other field without allocating it — `&str` borrows straight
/// out of the input buffer when the verdict has no escapes (it never does).
#[derive(Deserialize)]
struct StaticProbe<'a> {
    #[serde(borrow, default)]
    current_verdict: Option<&'a str>,
}

/// The hot path's cheap front door: decide whether a payload carries a static
/// verdict that settles the command without remote approval, reading only
/// `current_verdict` rather than building the whole [`Value`] tree. The binary
/// runs this on every invocation, so the common static-allow/deny case
/// short-circuits to `defer` without parsing the rest of the payload or
/// collecting CLI args. Returns `None` when the payload does not parse, so the
/// caller falls back to a full parse that surfaces the precise error.
/// [`is_static_decision`] is the same predicate over an already-parsed value.
pub fn static_decision(stdin: &str) -> Option<bool> {
    let probe: StaticProbe = serde_json::from_str(stdin).ok()?;
    Some(is_static_verdict(probe.current_verdict))
}

/// Build the JSON body POSTed to open an approval request. allowlister's
/// protocol-v3 payload is forwarded verbatim — `protocol_version`, `subject`,
/// `command`, `fragments`, `tool`, the harness `session_id`, and the pre-plugin
/// verdict/reason — so the server records the real structured decomposition
/// (and the originating harness session) instead of re-deriving it.
pub fn build_create_body(input: &Value) -> Value {
    match input {
        Value::Object(_) => input.clone(),
        _ => Value::Object(serde_json::Map::new()),
    }
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
pub fn triage(stdin: &str) -> Result<Triage, serde_json::Error> {
    let input: Value = serde_json::from_str(stdin)?;
    if is_static_decision(&input) {
        Ok(Triage::Defer)
    } else {
        Ok(Triage::NeedsApproval(build_create_body(&input)))
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
    fn local_prompt_lays_out_command_cwd_and_instruction() {
        assert_eq!(
            local_prompt("gh pr merge 42", "~/src/app"),
            "\nallowlister-remote approval required\n  command: gh pr merge 42\n  cwd: ~/src/app\nApprove here or in the web app. [a]llow / [d]eny: "
        );
    }

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
        // A protocol-v3 shell payload: the create body forwards the structured
        // fragments and the harness session id verbatim, not just the flat
        // command/verdict fields.
        let body = r#"{"protocol_version":3,"subject":"shell","session_id":"9f3c1a2b","current_verdict":"defer","command":"gh pr merge 42","fragments":[{"display":"gh pr merge 42","verdict":"defer","role":"standalone","rule":null}]}"#;
        match triage(body).expect("valid payload") {
            Triage::NeedsApproval(create) => {
                assert_eq!(create["command"], "gh pr merge 42");
                assert_eq!(create["subject"], "shell");
                assert_eq!(create["protocol_version"], 3);
                assert_eq!(create["session_id"], "9f3c1a2b");
                assert_eq!(create["fragments"][0]["display"], "gh pr merge 42");
            }
            Triage::Defer => panic!("defer verdict must reach the server"),
        }
        assert_eq!(
            triage(r#"{"current_verdict":"allow"}"#).expect("valid"),
            Triage::Defer
        );
        assert!(matches!(
            triage(r#"{"current_verdict":"ask"}"#).expect("valid"),
            Triage::NeedsApproval(_)
        ));
    }

    #[test]
    fn static_decision_probe_matches_value_predicate_and_tolerates_garbage() {
        // The cheap stdin probe agrees with the Value-based predicate across the
        // verdicts the harness sends.
        for (payload, expected) in [
            (
                r#"{"current_verdict":"allow","command":"git status"}"#,
                true,
            ),
            (r#"{"current_verdict":"deny"}"#, true),
            (r#"{"current_verdict":"defer","command":"x"}"#, false),
            (r#"{"current_verdict":"ask"}"#, false),
            (r#"{"command":"git status"}"#, false),
        ] {
            let input: Value = serde_json::from_str(payload).expect("valid");
            assert_eq!(static_decision(payload), Some(expected));
            assert_eq!(is_static_decision(&input), expected);
        }
        // Unparseable input yields None so the caller can fall back to a full
        // parse that surfaces the precise error.
        assert_eq!(static_decision("not json"), None);
    }

    #[test]
    fn create_body_forwards_tool_calls_verbatim() {
        let body = r#"{"protocol_version":2,"subject":"tool","current_verdict":"defer","tool":{"name":"mcp__github__create_issue","capability":"mcp","params":{},"raw":{"repo":"app"}}}"#;
        let input: Value = serde_json::from_str(body).expect("valid");
        let create = build_create_body(&input);
        assert_eq!(create["subject"], "tool");
        assert_eq!(create["tool"]["name"], "mcp__github__create_issue");
        assert_eq!(create["tool"]["raw"]["repo"], "app");
        // A non-object payload degrades to an empty object rather than panicking.
        assert_eq!(build_create_body(&Value::Null), serde_json::json!({}));
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
        assert!(triage("not json").is_err());
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
