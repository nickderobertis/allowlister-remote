//! Fixtures shared by the bench targets (`engine`, `engine_allocs`). This file
//! lives in a subdirectory so cargo's bench auto-discovery never treats it as a
//! target of its own; each bench pulls it in with `#[path]`.

// Each bench target uses a subset of these helpers; the unused remainder in any
// one target is expected.
#![allow(dead_code)]

/// Labelled harness payloads covering the shapes the plugin parses on stdin: a
/// bare command, a multi-stage pipeline, a static allow verdict that
/// short-circuits before any network call, a fully-populated payload, and a
/// long `&&` chain that stresses command-string parsing.
pub fn corpus() -> Vec<(&'static str, String)> {
    vec![
        ("simple", payload("ls -la", "defer", None)),
        (
            "pipeline",
            payload("gh pr list | head -20 | wc -l", "defer", None),
        ),
        ("static_allow", payload("git status", "allow", None)),
        ("rich", rich_payload("gh pr merge 42")),
        ("chain", payload(&chain(32), "defer", None)),
    ]
}

/// A minimal PreToolUse-style payload: the fields the plugin reads to triage and
/// open a request. The inputs never contain JSON metacharacters, so no escaping
/// is needed.
pub fn payload(command: &str, verdict: &str, reason: Option<&str>) -> String {
    let reason = reason
        .map(|reason| format!(r#","current_reason":"{reason}""#))
        .unwrap_or_default();
    format!(r#"{{"current_verdict":"{verdict}","command":"{command}","cwd":"/tmp"{reason}}}"#)
}

/// A fully-populated payload — every field the create body forwards — so the
/// build step does real work for every key rather than filling nulls.
pub fn rich_payload(command: &str) -> String {
    format!(
        r#"{{"current_verdict":"defer","current_reason":"needs approval","command":"{command}","cwd":"/home/user/project","harness":"codex"}}"#
    )
}

/// An `&&` chain of `len` simple commands, for stressing command-string parsing.
pub fn chain(len: usize) -> String {
    (0..len)
        .map(|i| format!("echo step{i}"))
        .collect::<Vec<_>>()
        .join(" && ")
}

/// Labelled decision-response bodies the plugin interprets while polling: a
/// pending hold, a remote allow, a remote deny, and a malformed body that must
/// fall back to `ask`.
pub fn decision_bodies() -> Vec<(&'static str, &'static str)> {
    vec![
        ("pending", r#"{"status":"pending"}"#),
        (
            "allow",
            r#"{"requestId":"req_1","verdict":"allow","reason":"remote allowed"}"#,
        ),
        (
            "deny",
            r#"{"requestId":"req_1","verdict":"deny","reason":"remote denied"}"#,
        ),
        ("malformed", r#"{"verdict":"#),
    ]
}

/// Labelled terminal input lines: an allow, a deny, and an unrecognized line the
/// operator would simply retype.
pub fn local_inputs() -> Vec<(&'static str, &'static str)> {
    vec![("allow", "a\n"), ("deny", "deny"), ("retry", "huh?")]
}
