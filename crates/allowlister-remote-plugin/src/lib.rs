//! Remote-specific decision helpers for the allowlister-remote plugin.
//!
//! The terminal approval experience — parsing allowlister's payload, reducing it
//! to the flagged fragments, rendering the local `/dev/tty` prompt, and running
//! that prompt — lives in the standalone
//! [`allowlister_terminal_approval`](https://crates.io/crates/allowlister-terminal-approval-plugin)
//! crate, which this crate re-exports so the binary and `daemon.rs` reach it
//! under the familiar `allowlister_remote_plugin::` path. What stays here is the
//! part that is genuinely *remote*: building the create-request body handed to
//! the daemon, triaging a payload into defer-vs-approve, and interpreting the
//! decision the daemon relays off the broker.
//!
//! The binary (`src/main.rs`) reads a harness payload on stdin, hands the
//! approval request to the host daemon over local IPC, then races the shared
//! local-terminal prompt against the verdict the daemon relays from the broker.

use serde::Deserialize;
use serde_json::Value;

// The terminal approval experience, shared with the standalone plugin. Re-exported
// so existing `allowlister_remote_plugin::` call sites (the binary, `daemon.rs`,
// the benches, and the terminal-fixture test) keep resolving unchanged.
pub use allowlister_terminal_approval::{
    flagged_fragments, is_static_decision, local_prompt, parse_local_input, request_summary,
    start_local_prompt, static_decision, tool_input_json, FlaggedFragment, LocalDecision,
    LocalPrompt, PromptLabels,
};

/// The banner and call-to-action for allowlister-remote's local prompt. The rest
/// of the prompt is rendered identically to the standalone plugin (and the web
/// app) by [`local_prompt`]; only these two lines differ, so remote's terminal
/// UX — "approve here or in the web app" — is preserved verbatim. The
/// terminal-fixture test (`tests/terminal_prompt.rs`) pins the output against the
/// recorded gallery prompts using exactly these labels.
pub const REMOTE_LABELS: PromptLabels<'static> = PromptLabels {
    header: "allowlister-remote approval required",
    instruction: "Approve here or in the web app. [a]llow / [d]eny: ",
};

/// Build the JSON body POSTed to open an approval request. allowlister's
/// protocol-v3 payload is forwarded verbatim — `protocol_version`, `subject`,
/// `command`, `fragments`, `tool`, the harness `session_id`, and the pre-plugin
/// verdict/reason — so the server records the real structured decomposition (and
/// the originating harness session) instead of re-deriving it.
pub fn build_create_body(input: &Value) -> Value {
    match input {
        Value::Object(_) => input.clone(),
        _ => Value::Object(serde_json::Map::new()),
    }
}

/// Outcome of [`triage`].
#[derive(Debug, PartialEq)]
pub enum Triage {
    /// The verdict needs no remote approval (allow/deny/defer/missing); defer to
    /// allowlister without a round-trip.
    Defer,
    /// An `ask` verdict needs remote approval; carries the body the plugin hands
    /// to the daemon.
    NeedsApproval(Value),
}

/// The pre-network pipeline: parse a harness payload, then either short-circuit a
/// static verdict or produce the create-request body to POST. Mirrors the
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
struct DecisionBody {
    verdict: Option<String>,
    reason: Option<String>,
}

/// A decision message interpreted from the line the daemon relays off the broker.
#[derive(Debug, PartialEq)]
pub enum RemoteDecision {
    /// A human decided. `verdict` is normalized to `allow`/`deny`.
    Decided {
        verdict: &'static str,
        reason: String,
    },
    /// The body did not parse as a decision; the caller falls back to `ask`.
    Invalid(String),
}

/// Interpret a decision message body. Any verdict other than `deny` is treated as
/// `allow` (the broker only ever relays `allow`/`deny`), and a parse failure is
/// reported so the caller can fall back to `ask` rather than block forever.
pub fn interpret_decision(body: &str) -> RemoteDecision {
    let decision: DecisionBody = match serde_json::from_str(body) {
        Ok(decision) => decision,
        Err(error) => return RemoteDecision::Invalid(format!("invalid remote decision: {error}")),
    };
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
    fn only_ask_reaches_the_server_other_verdicts_defer() {
        // A protocol-v3 shell payload with an `ask` verdict: the create body
        // forwards the structured fragments and the harness session id verbatim,
        // not just the flat command/verdict fields.
        let body = r#"{"protocol_version":3,"subject":"shell","session_id":"9f3c1a2b","current_verdict":"ask","command":"gh pr merge 42","fragments":[{"display":"gh pr merge 42","verdict":"ask","role":"standalone","rule":"ask before merging a PR"}]}"#;
        match triage(body).expect("valid payload") {
            Triage::NeedsApproval(create) => {
                assert_eq!(create["command"], "gh pr merge 42");
                assert_eq!(create["subject"], "shell");
                assert_eq!(create["protocol_version"], 3);
                assert_eq!(create["session_id"], "9f3c1a2b");
                assert_eq!(create["fragments"][0]["display"], "gh pr merge 42");
            }
            Triage::Defer => panic!("ask verdict must reach the server"),
        }
        // Everything that is not `ask` defers without a round-trip: terminal
        // allow/deny, allowlister's no-opinion `defer`, and a missing verdict.
        for settled in [
            r#"{"current_verdict":"allow"}"#,
            r#"{"current_verdict":"deny"}"#,
            r#"{"current_verdict":"defer"}"#,
            r#"{"command":"gh pr merge 42"}"#,
        ] {
            assert_eq!(triage(settled).expect("valid"), Triage::Defer);
        }
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
    fn triage_surfaces_invalid_json() {
        assert!(triage("not json").is_err());
    }

    #[test]
    fn decision_allow_deny_and_invalid() {
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

    #[test]
    fn remote_labels_reproduce_the_committed_prompt_wording() {
        // The extraction is faithful only if remote's labels render the exact
        // banner + call-to-action the gallery fixture recorded. The full
        // fixture-vs-binary guard is `tests/terminal_prompt.rs`; this is a fast
        // in-crate sanity check on the two lines that are remote-specific.
        let rendered = local_prompt(&REMOTE_LABELS, "gh pr merge 42", "~/src/app", &[], None);
        assert!(rendered.starts_with("\nallowlister-remote approval required\n"));
        assert!(rendered.ends_with("Approve here or in the web app. [a]llow / [d]eny: "));
    }
}
