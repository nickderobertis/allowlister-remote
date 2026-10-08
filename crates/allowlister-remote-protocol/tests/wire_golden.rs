//! The protocol-v3 wire golden. `wire/protocol-v3.json` was captured from the
//! tree before this crate existed (the plugin binary's real `create` line and the
//! daemon's and broker's envelope functions, byte for byte), so it is a fixed
//! definition of the existing wire format: any field or envelope change fails
//! here even when every consumer adopts it consistently. Changing the protocol
//! means changing this fixture deliberately, together with the web app's
//! restatement (`apps/web/src/protocol-contract.test.ts` reads the same file).

use allowlister_remote_protocol::{wire_drift, WIRE_FIXTURE};
use serde_json::Value;

fn fixture() -> Value {
    serde_json::from_str(WIRE_FIXTURE).expect("wire/protocol-v3.json is JSON")
}

#[test]
fn every_builder_reproduces_the_committed_wire_bytes() {
    assert_eq!(wire_drift(&fixture()), Vec::<String>::new());
}

#[test]
fn a_renamed_field_in_a_divergent_copy_is_reported() {
    let mut divergent = fixture();
    let resolved = &mut divergent["frames"]["broker_to_pwa.resolved"];
    let id = resolved["requestId"].take();
    resolved.as_object_mut().unwrap().remove("requestId");
    resolved["request_id"] = id;
    let drift = wire_drift(&divergent);
    assert_eq!(drift.len(), 1, "{drift:?}");
    assert!(drift[0].starts_with("broker_to_pwa.resolved:"), "{drift:?}");
}

#[test]
fn an_extra_or_missing_envelope_is_reported() {
    let mut divergent = fixture();
    let frames = divergent["frames"].as_object_mut().unwrap();
    frames.remove("daemon_to_broker.withdraw");
    frames.insert(
        "broker_to_pwa.cleared".into(),
        serde_json::json!({"type": "cleared"}),
    );
    let drift = wire_drift(&divergent);
    assert!(
        drift
            .iter()
            .any(|d| d.starts_with("daemon_to_broker.withdraw: missing")),
        "{drift:?}"
    );
    assert!(
        drift
            .iter()
            .any(|d| d.starts_with("broker_to_pwa.cleared: in the fixture")),
        "{drift:?}"
    );
}

#[test]
fn a_changed_payload_field_is_reported_on_every_envelope_carrying_it() {
    let mut divergent = fixture();
    // The payload changes, but the frames still pin the old bytes.
    divergent["payload"]["protocol_version"] = 4.into();
    let drift = wire_drift(&divergent);
    for name in [
        "plugin_to_daemon.create",
        "daemon_to_broker.create",
        "broker_to_pwa.added",
        "broker_to_pwa.snapshot",
    ] {
        assert!(
            drift.iter().any(|d| d.starts_with(name)),
            "{name} not reported: {drift:?}"
        );
    }
}
