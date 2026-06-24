//! Pure, network-free decision helpers for the allowlister-remote plugin.
//!
//! The binary (`src/main.rs`) is mostly I/O: it reads a harness payload on
//! stdin, hands the approval request to the host daemon over local IPC, then
//! races a local-terminal prompt against the verdict the daemon relays from the
//! broker. The work that is *not* I/O — parsing the incoming payload, deciding
//! whether a static verdict short-circuits the remote round-trip, building the
//! create-request body, and interpreting a decision message — lives here so it
//! can be unit-tested and benchmarked (`benches/engine.rs`) without spawning a
//! process or opening a socket.

use serde::Deserialize;
use serde_json::Value;

/// A decision captured from the operator at the local terminal.
pub struct LocalDecision {
    pub verdict: &'static str,
    pub reason: String,
}

/// A fragment allowlister flagged for the operator, reduced to what the terminal
/// prompt surfaces: the command text that tripped the gate and the rule that
/// flagged it (if any). This is one row of the web app's "needs your attention"
/// list, rendered as plain text instead of a card.
pub struct FlaggedFragment {
    pub display: String,
    pub rule: Option<String>,
}

/// The fragments the operator must actually weigh: allowlister already decided
/// the rest are `allow`, so anything else (ask/deny/defer) is what gets
/// surfaced. Mirrors the web app's `flaggedFragments` (in `apps/web/src/approval.ts`),
/// including its fallback to the full set when — unexpectedly — nothing is
/// flagged. A payload with no `fragments` (a tool call) yields an empty list, so
/// the prompt simply omits the fragment block and shows the action alone.
pub fn flagged_fragments(input: &Value) -> Vec<FlaggedFragment> {
    let Some(fragments) = input.get("fragments").and_then(Value::as_array) else {
        return Vec::new();
    };
    let to_flagged = |fragment: &Value| FlaggedFragment {
        display: fragment
            .get("display")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        rule: fragment
            .get("rule")
            .and_then(Value::as_str)
            .map(str::to_string),
    };
    let flagged: Vec<FlaggedFragment> = fragments
        .iter()
        .filter(|fragment| fragment.get("verdict").and_then(Value::as_str) != Some("allow"))
        .map(to_flagged)
        .collect();
    if flagged.is_empty() {
        fragments.iter().map(to_flagged).collect()
    } else {
        flagged
    }
}

/// A tool call's verbatim arguments (`tool.raw`), pretty-printed as indented
/// JSON for the local terminal prompt. This is the terminal twin of the web
/// app's tool-call detail, which shows the operator the exact input the agent
/// passed — so a terminal approval is not blind to what the tool will do, only
/// its name. Returns `None` for a shell payload (no `tool`) or a tool call that
/// carried no arguments, so the prompt simply omits the block. Mirrors the web
/// app's `toolCallLines` in reading `raw` (the agent's actual input) rather than
/// the adapter's canonical `params`.
pub fn tool_input_json(input: &Value) -> Option<String> {
    let raw = input.get("tool").and_then(|tool| tool.get("raw"))?;
    if raw.as_object().is_none_or(serde_json::Map::is_empty) {
        return None;
    }
    serde_json::to_string_pretty(raw).ok()
}

/// The exact text the plugin writes to `/dev/tty` to open a local approval
/// prompt. It mirrors the web app's shell-detail flow: first the fragments
/// allowlister flagged ("needs your attention" — the command that tripped plus
/// its rule), then the full command, the cwd, and the allow/deny instruction.
/// For a tool call there are no fragments; instead `tool_input` carries its
/// arguments as formatted JSON (see [`tool_input_json`]), rendered under the
/// action so the operator sees what the tool will do.
/// Extracted here as a pure function so the binary's real terminal surface is
/// unit-testable and so the visual-docs capture can render the genuine prompt
/// from a fixture pinned to this output (see
/// `apps/web/screenshots/terminal.capture.ts`). The caller appends the trailing
/// newline (`writeln!`), so this returns the line block without it.
pub fn local_prompt(
    command: &str,
    cwd: &str,
    flagged: &[FlaggedFragment],
    tool_input: Option<&str>,
) -> String {
    let mut prompt = String::from("\nallowlister-remote approval required\n");

    if !flagged.is_empty() {
        prompt.push_str("\nNeeds your attention:\n");
        for fragment in flagged {
            prompt.push_str("  ");
            prompt.push_str(&fragment.display);
            prompt.push('\n');
            if let Some(rule) = &fragment.rule {
                prompt.push_str("    ");
                prompt.push_str(rule);
                prompt.push('\n');
            }
        }
    }

    // The full command always follows the flagged fragments, each line indented
    // so a multi-line script reads as one block (a tool call is a single line:
    // its name, with the arguments rendered as JSON in the block below).
    prompt.push_str("\nFull command:\n");
    for line in command.split('\n') {
        prompt.push_str("  ");
        prompt.push_str(line);
        prompt.push('\n');
    }

    // A tool call's formatted arguments, each line indented to match the command
    // block so the JSON reads as one unit beneath the action it belongs to.
    if let Some(tool_input) = tool_input {
        prompt.push_str("\nTool input:\n");
        for line in tool_input.split('\n') {
            prompt.push_str("  ");
            prompt.push_str(line);
            prompt.push('\n');
        }
    }

    prompt.push_str(&format!(
        "\n  cwd: {cwd}\nApprove here or in the web app. [a]llow / [d]eny: "
    ));
    prompt
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
/// only an explicit `ask` verdict — allowlister wanting to prompt the operator —
/// needs remote approval. Every other state settles without a round-trip: a
/// terminal `allow`/`deny`, a `defer` (allowlister abstains and runs its normal
/// flow), or a missing verdict. So only `ask` reaches the server.
fn is_static_verdict(verdict: Option<&str>) -> bool {
    verdict != Some("ask")
}

/// Whether the harness settled this command without needing remote approval, so
/// the plugin can defer without contacting the daemon. Only an `ask` verdict —
/// the case allowlister would itself prompt on — reaches the server; `allow`,
/// `deny`, `defer`, and a missing verdict are all left to allowlister's own flow.
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

/// The hot path's cheap front door: decide whether a payload settles the command
/// without remote approval, reading only `current_verdict` rather than building
/// the whole [`Value`] tree. The binary runs this on every invocation, so the
/// common non-`ask` case (allow/deny/defer/missing) short-circuits to `defer`
/// without parsing the rest of the payload or collecting CLI args; only an `ask`
/// verdict falls through to the network path. Returns `None` when the payload
/// does not parse, so the caller falls back to a full parse that surfaces the
/// precise error.
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
    /// The verdict needs no remote approval (allow/deny/defer/missing); defer to
    /// allowlister without a round-trip.
    Defer,
    /// An `ask` verdict needs remote approval; carries the body the plugin hands
    /// to the daemon.
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

/// Interpret a decision message body. Any verdict other than `deny` is treated
/// as `allow` (the broker only ever relays `allow`/`deny`), and a parse failure
/// is reported so the caller can fall back to `ask` rather than block forever.
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
    fn local_prompt_surfaces_flagged_fragments_then_the_full_command() {
        // Mirrors the web app: a "needs your attention" block (the flagged
        // fragment plus its rule) precedes the full command and the cwd.
        let flagged = [
            FlaggedFragment {
                display: "npm publish --access public".to_string(),
                rule: Some("ask before publishing a package".to_string()),
            },
            FlaggedFragment {
                display: "git push origin main --tags".to_string(),
                rule: None,
            },
        ];
        assert_eq!(
            local_prompt(
                "npm ci\nnpm publish --access public",
                "~/src/app",
                &flagged,
                None
            ),
            "\nallowlister-remote approval required\n\nNeeds your attention:\n  npm publish --access public\n    ask before publishing a package\n  git push origin main --tags\n\nFull command:\n  npm ci\n  npm publish --access public\n\n  cwd: ~/src/app\nApprove here or in the web app. [a]llow / [d]eny: "
        );
    }

    #[test]
    fn local_prompt_without_fragments_shows_the_action_alone() {
        // A tool call has no fragments: no "needs your attention" block, just the
        // action under "Full command:". With no arguments there is no tool-input
        // block either.
        assert_eq!(
            local_prompt("mcp__github__create_issue", "~/src/app", &[], None),
            "\nallowlister-remote approval required\n\nFull command:\n  mcp__github__create_issue\n\n  cwd: ~/src/app\nApprove here or in the web app. [a]llow / [d]eny: "
        );
    }

    #[test]
    fn local_prompt_renders_tool_input_as_indented_json() {
        // A tool call with arguments: the formatted JSON follows the action under
        // a "Tool input:" block, each line indented to match the command block.
        let tool = serde_json::json!({
            "tool": {
                "name": "mcp__github__create_issue",
                "capability": "mcp",
                "raw": {"repo": "allowlister-remote", "title": "Ship it"},
            }
        });
        let tool_input = tool_input_json(&tool).expect("tool with raw args yields JSON");
        assert_eq!(
            local_prompt("mcp__github__create_issue", "~/src/app", &[], Some(&tool_input)),
            "\nallowlister-remote approval required\n\nFull command:\n  mcp__github__create_issue\n\nTool input:\n  {\n    \"repo\": \"allowlister-remote\",\n    \"title\": \"Ship it\"\n  }\n\n  cwd: ~/src/app\nApprove here or in the web app. [a]llow / [d]eny: "
        );
    }

    #[test]
    fn tool_input_json_pretty_prints_raw_and_skips_empty_or_shell() {
        // The agent's verbatim `raw` input is pretty-printed as indented JSON.
        let tool = serde_json::json!({
            "tool": {"name": "write", "raw": {"path": "/etc/hosts", "lines": 12}}
        });
        // serde_json renders object keys in sorted order (no `preserve_order`),
        // which keeps the prompt deterministic regardless of input key order.
        assert_eq!(
            tool_input_json(&tool).as_deref(),
            Some("{\n  \"lines\": 12,\n  \"path\": \"/etc/hosts\"\n}")
        );
        // A tool call with no arguments, or one whose `raw` is empty, has no block.
        assert_eq!(
            tool_input_json(&serde_json::json!({"tool": {"name": "ls"}})),
            None
        );
        assert_eq!(
            tool_input_json(&serde_json::json!({"tool": {"name": "ls", "raw": {}}})),
            None
        );
        // A shell payload (no `tool`) never renders a tool-input block.
        assert_eq!(tool_input_json(&serde_json::json!({"command": "ls"})), None);
    }

    #[test]
    fn flagged_fragments_picks_non_allow_then_falls_back_to_all() {
        // Only the ask/deny/defer fragments are flagged; the allowed ones drop.
        let shell = serde_json::json!({
            "fragments": [
                {"display": "npm ci", "verdict": "allow", "rule": "allow npm scripts"},
                {"display": "npm publish --access public", "verdict": "ask", "rule": "ask before publishing a package"},
                {"display": "echo done", "verdict": "defer", "rule": null},
            ]
        });
        let flagged = flagged_fragments(&shell);
        assert_eq!(flagged.len(), 2);
        assert_eq!(flagged[0].display, "npm publish --access public");
        assert_eq!(
            flagged[0].rule.as_deref(),
            Some("ask before publishing a package")
        );
        assert_eq!(flagged[1].display, "echo done");
        assert_eq!(flagged[1].rule, None);

        // All-allow is unexpected at a prompt, but falls back to the full set
        // rather than rendering an empty block.
        let all_allow = serde_json::json!({
            "fragments": [{"display": "npm ci", "verdict": "allow", "rule": "allow npm scripts"}]
        });
        let fallback = flagged_fragments(&all_allow);
        assert_eq!(fallback.len(), 1);
        assert_eq!(fallback[0].display, "npm ci");

        // A tool call (no fragments) yields an empty list.
        assert!(flagged_fragments(&serde_json::json!({"tool": {"name": "write"}})).is_empty());
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
    fn static_decision_probe_matches_value_predicate_and_tolerates_garbage() {
        // The cheap stdin probe agrees with the Value-based predicate across the
        // verdicts the harness sends.
        for (payload, expected) in [
            (
                r#"{"current_verdict":"allow","command":"git status"}"#,
                true,
            ),
            (r#"{"current_verdict":"deny"}"#, true),
            (r#"{"current_verdict":"defer","command":"x"}"#, true),
            (r#"{"current_verdict":"ask"}"#, false),
            (r#"{"command":"git status"}"#, true),
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
}
