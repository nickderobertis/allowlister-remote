//! The allowlister-remote **protocol-v3 wire contract**: the one authoritative
//! definition of every JSON envelope exchanged between the plugin, the daemon,
//! the broker, and the PWA.
//!
//! The plugin, daemon, and broker build and parse their frames through this
//! crate instead of restating the field names. The committed fixture
//! (`wire/protocol-v3.json`) pins the exact bytes of every envelope and is what
//! the TypeScript side (`apps/web/src/protocol-contract.test.ts`) is checked
//! against, so a restatement that drifts — here or in the web app — fails a test.
//!
//! ## Envelopes (JSON text frames, one per line on the local IPC)
//!
//! plugin → daemon (IPC): `create {payload}`, `decision {verdict, reason}` (local terminal).
//! daemon → plugin (IPC): `ack`, and a broker `decision` relayed verbatim.
//! daemon → broker: `create {request}`, `decision {requestId, verdict, reason}`,
//! `withdraw {requestId}`.
//! broker → daemon: `decision {requestId, verdict, reason}`.
//! PWA → broker: `subscribe`, `decision {requestId, verdict, reason}`.
//! broker → PWA: `snapshot {requests}`, `added {request}`, `resolved {requestId}`.
//!
//! A `request` is allowlister's protocol-v3 payload forwarded verbatim plus the
//! daemon-assigned `id`.

use serde_json::{json, Map, Value};

/// The discriminating field every envelope carries.
pub const TYPE: &str = "type";
/// The id of a pending request on the broker-facing envelopes.
pub const REQUEST_ID: &str = "requestId";
/// The decision verdict (`allow` / `deny`).
pub const VERDICT: &str = "verdict";
/// The human reason accompanying a decision.
pub const REASON: &str = "reason";
/// The allowlister payload the plugin hands the daemon.
pub const PAYLOAD: &str = "payload";
/// A pending request (payload + `id`) on the broker-facing envelopes.
pub const REQUEST: &str = "request";
/// The pending set on a `snapshot`.
pub const REQUESTS: &str = "requests";
/// The daemon-assigned id stamped into a forwarded request.
pub const ID: &str = "id";

/// Envelope `type` values.
pub mod kind {
    pub const CREATE: &str = "create";
    pub const DECISION: &str = "decision";
    pub const WITHDRAW: &str = "withdraw";
    pub const ACK: &str = "ack";
    pub const SUBSCRIBE: &str = "subscribe";
    pub const SNAPSHOT: &str = "snapshot";
    pub const ADDED: &str = "added";
    pub const RESOLVED: &str = "resolved";
}

/// The dispatch key of a frame: its `type`, or `""` when absent.
pub fn message_kind(message: &Value) -> &str {
    message.get(TYPE).and_then(Value::as_str).unwrap_or("")
}

/// A string field of a frame, if present.
pub fn str_field<'a>(message: &'a Value, field: &str) -> Option<&'a str> {
    message.get(field).and_then(Value::as_str)
}

/// plugin → daemon: open a request carrying allowlister's payload.
pub fn plugin_create(payload: &Value) -> Value {
    json!({ TYPE: kind::CREATE, PAYLOAD: payload })
}

/// plugin → daemon: a decision taken at the local terminal.
pub fn local_decision(verdict: &str, reason: &str) -> Value {
    json!({ TYPE: kind::DECISION, VERDICT: verdict, REASON: reason })
}

/// daemon → plugin: the local decision was relayed upstream.
pub fn ack() -> Value {
    json!({ TYPE: kind::ACK })
}

/// The forwarded request: the plugin's `payload` object with the daemon-assigned
/// `id` stamped in (a non-object payload is wrapped as `{payload, id}`).
pub fn request_with_id(payload: Option<&Value>, id: &str) -> Value {
    let mut request = match payload {
        Some(Value::Object(map)) => map.clone(),
        other => {
            let mut map = Map::new();
            map.insert(PAYLOAD.to_string(), other.cloned().unwrap_or(Value::Null));
            map
        }
    };
    request.insert(ID.to_string(), json!(id));
    Value::Object(request)
}

/// daemon → broker: open a request this daemon owns.
pub fn broker_create(request: &Value) -> Value {
    json!({ TYPE: kind::CREATE, REQUEST: request })
}

/// daemon ↔ broker ↔ PWA: a decision addressed to a pending request.
pub fn decision(request_id: &str, verdict: &str, reason: &str) -> Value {
    json!({ TYPE: kind::DECISION, REQUEST_ID: request_id, VERDICT: verdict, REASON: reason })
}

/// daemon → broker: the plugin exited before a decision; cancel the request.
pub fn withdraw(request_id: &str) -> Value {
    json!({ TYPE: kind::WITHDRAW, REQUEST_ID: request_id })
}

/// PWA → broker: receive a snapshot, then live updates.
pub fn subscribe() -> Value {
    json!({ TYPE: kind::SUBSCRIBE })
}

/// broker → PWA: the current pending set.
pub fn snapshot(requests: &[&Value]) -> Value {
    json!({ TYPE: kind::SNAPSHOT, REQUESTS: requests })
}

/// broker → PWA: a new pending request.
pub fn added(request: &Value) -> Value {
    json!({ TYPE: kind::ADDED, REQUEST: request })
}

/// broker → PWA: a request was decided or withdrawn.
pub fn resolved(request_id: &str) -> Value {
    json!({ TYPE: kind::RESOLVED, REQUEST_ID: request_id })
}

/// The committed protocol-v3 fixture: every envelope's exact wire form.
pub const WIRE_FIXTURE: &str = include_str!("../wire/protocol-v3.json");

/// Rebuild every fixture frame from this crate's builders and return one line per
/// frame whose wire text differs from the fixture's (empty when they agree).
/// The fixture is passed in so a test can prove a divergent copy is caught.
pub fn wire_drift(fixture: &Value) -> Vec<String> {
    let id = fixture
        .get(REQUEST_ID)
        .and_then(Value::as_str)
        .unwrap_or("");
    let payload = fixture.get(PAYLOAD).cloned().unwrap_or(Value::Null);
    let request = request_with_id(Some(&payload), id);
    let built: [(&str, Value); 13] = [
        ("plugin_to_daemon.create", plugin_create(&payload)),
        (
            "plugin_to_daemon.decision",
            local_decision("deny", "denied at the local terminal"),
        ),
        (
            "daemon_to_plugin.decision",
            decision(id, "allow", "approved from the web"),
        ),
        ("daemon_to_plugin.ack", ack()),
        ("daemon_to_broker.create", broker_create(&request)),
        (
            "daemon_to_broker.decision",
            decision(id, "deny", "denied at the local terminal"),
        ),
        ("daemon_to_broker.withdraw", withdraw(id)),
        (
            "broker_to_daemon.decision",
            decision(id, "allow", "approved from the web"),
        ),
        ("pwa_to_broker.subscribe", subscribe()),
        (
            "pwa_to_broker.decision",
            decision(id, "allow", "approved from the web"),
        ),
        ("broker_to_pwa.snapshot", snapshot(&[&request])),
        ("broker_to_pwa.added", added(&request)),
        ("broker_to_pwa.resolved", resolved(id)),
    ];
    let frames = fixture.get("frames").and_then(Value::as_object);
    let mut drift = Vec::new();
    for (name, value) in &built {
        let actual = value.to_string();
        // Compare wire text (serde_json writes keys sorted), not JSON equality:
        // the fixture pins the exact bytes on the wire.
        match frames
            .and_then(|frames| frames.get(*name))
            .map(Value::to_string)
        {
            Some(expected) if expected == actual => {}
            Some(expected) => drift.push(format!("{name}: fixture {expected} != built {actual}")),
            None => drift.push(format!("{name}: missing from the fixture")),
        }
    }
    if let Some(frames) = frames {
        for name in frames.keys() {
            if !built.iter().any(|(built_name, _)| built_name == name) {
                drift.push(format!("{name}: in the fixture but built by nothing"));
            }
        }
    }
    drift
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_object_payload_is_wrapped_with_the_id() {
        assert_eq!(
            request_with_id(Some(&json!("raw")), "7"),
            json!({"payload": "raw", "id": "7"})
        );
        assert_eq!(
            request_with_id(None, "7"),
            json!({"payload": null, "id": "7"})
        );
    }

    #[test]
    fn kind_and_fields_tolerate_missing_values() {
        assert_eq!(message_kind(&json!({"type": "added"})), "added");
        assert_eq!(message_kind(&json!({})), "");
        assert_eq!(str_field(&json!({"requestId": "a"}), REQUEST_ID), Some("a"));
        assert_eq!(str_field(&json!({"requestId": 1}), REQUEST_ID), None);
    }

    #[test]
    fn a_fixture_without_frames_reports_every_envelope_missing() {
        assert_eq!(wire_drift(&json!({})).len(), 13);
    }
}
