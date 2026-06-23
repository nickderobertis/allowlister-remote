//! Fixtures shared by the daemon bench targets (`protocol`, `protocol_allocs`).
//! This file lives in a subdirectory so cargo's bench auto-discovery never treats
//! it as a target of its own; each bench pulls it in with `#[path]`.

// Each bench target uses a subset of these helpers; the unused remainder in any
// one target is expected.
#![allow(dead_code)]

/// A fixed id the build benches stamp into the create envelope. Benches must be
/// deterministic, so the real `new_request_id` (which reads the wall clock and a
/// pid) is deliberately not used here.
pub const REQUEST_ID: &str = "12345-678901234567890-7";

/// Labelled `create` messages the plugin sends the daemon over the local IPC
/// socket: a bare command, a multi-stage pipeline, a fully-populated payload, and
/// a long `&&` chain that stresses the JSON re-serialization in
/// `build_create_msg`. These mirror the plugin bench corpus so the two ends are
/// measured over the same shapes.
pub fn create_msgs() -> Vec<(&'static str, String)> {
    vec![
        ("simple", create_msg("ls -la", None)),
        (
            "pipeline",
            create_msg("gh pr list | head -20 | wc -l", None),
        ),
        ("rich", create_msg("gh pr merge 42", Some("codex"))),
        ("chain", create_msg(&chain(32), None)),
    ]
}

/// A plugin → daemon `create` frame: the `{"type":"create","payload":{…}}`
/// envelope wrapping the allowlister body the plugin read on its stdin.
pub fn create_msg(command: &str, harness: Option<&str>) -> String {
    let harness = harness
        .map(|harness| format!(r#","harness":"{harness}""#))
        .unwrap_or_default();
    format!(
        r#"{{"type":"create","payload":{{"current_verdict":"defer","command":"{command}","cwd":"/home/user/project"{harness}}}}}"#
    )
}

/// An `&&` chain of `len` simple commands, for stressing the command-string
/// re-serialization the create envelope does.
pub fn chain(len: usize) -> String {
    (0..len)
        .map(|i| format!("echo step{i}"))
        .collect::<Vec<_>>()
        .join(" && ")
}

/// Labelled inbound broker frames `route_decision`/`decision_target` parse: a
/// web allow, a web deny, a frame whose target id is missing (no route), a
/// non-decision frame the daemon ignores, and a malformed body.
pub fn inbound_frames() -> Vec<(&'static str, &'static str)> {
    vec![
        (
            "allow",
            r#"{"type":"decision","requestId":"req_1","verdict":"allow","reason":"approved in the web app"}"#,
        ),
        (
            "deny",
            r#"{"type":"decision","requestId":"req_1","verdict":"deny","reason":"denied in the web app"}"#,
        ),
        ("no_id", r#"{"type":"decision","verdict":"allow"}"#),
        ("other", r#"{"type":"snapshot","requests":[]}"#),
        ("malformed", r#"{"type":"decision"#),
    ]
}

/// Labelled local-terminal decision lines `local_decision` parses: an allow with
/// a reason, a deny with no reason (the synthesized-empty path), and a
/// non-decision line the daemon ignores.
pub fn local_lines() -> Vec<(&'static str, &'static str)> {
    vec![
        (
            "allow",
            r#"{"type":"decision","verdict":"allow","reason":"approved at the terminal"}"#,
        ),
        ("deny", r#"{"type":"decision","verdict":"deny"}"#),
        ("other", r#"{"type":"ack"}"#),
    ]
}
