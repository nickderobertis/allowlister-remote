//! Fixtures shared by the broker bench targets (`protocol`, `protocol_allocs`).
//! This file lives in a subdirectory so cargo's bench auto-discovery never treats
//! it as a target of its own; each bench pulls it in with `#[path]`.

// Each bench target uses a subset of these helpers; the unused remainder in any
// one target is expected.
#![allow(dead_code)]

use serde_json::{json, Value};

/// Labelled inbound wire frames the broker parses and dispatches: a daemon
/// `create`, a web `decision`, a daemon `withdraw`, and a PWA `subscribe`. These
/// are the frames `serde_json::from_str` + `message_kind` see on every edge.
pub fn inbound_frames() -> Vec<(&'static str, String)> {
    vec![
        ("create", create_frame("req_1", "gh pr merge 42")),
        ("decision", decision_frame("req_1", "allow")),
        (
            "withdraw",
            json!({ "type": "withdraw", "requestId": "req_1" }).to_string(),
        ),
        ("subscribe", json!({ "type": "subscribe" }).to_string()),
    ]
}

/// A daemon → broker `create` frame: the `{"type":"create","request":{…}}`
/// envelope the daemon sends, carrying the id-stamped allowlister request.
pub fn create_frame(id: &str, command: &str) -> String {
    json!({ "type": "create", "request": request(id, command) }).to_string()
}

/// A `decision` frame from either edge.
pub fn decision_frame(id: &str, verdict: &str) -> String {
    json!({
        "type": "decision",
        "requestId": id,
        "verdict": verdict,
        "reason": "decided in the web app",
    })
    .to_string()
}

/// A pending request body as it sits in broker state and is fanned out to PWAs.
pub fn request(id: &str, command: &str) -> Value {
    json!({
        "id": id,
        "current_verdict": "ask",
        "command": command,
        "cwd": "/home/user/project",
        "harness": "codex",
    })
}

/// `n` distinct pending requests, for charting how `snapshot_message` cost grows
/// with the pending set a newly-subscribed PWA receives.
pub fn requests(n: usize) -> Vec<Value> {
    (0..n)
        .map(|i| request(&format!("req_{i}"), &format!("gh pr merge {i}")))
        .collect()
}
