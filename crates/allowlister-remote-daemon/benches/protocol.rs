//! Criterion micro-benchmarks for the daemon's pure, network-free protocol path.
//!
//! These measure the in-process work the daemon does per message between its IPC
//! socket and the broker connection: parse a plugin's `create` line and build the
//! broker `create` envelope with the assigned id (`build_create_msg`), extract the
//! routing target of an inbound web decision (`decision_target`), and parse a
//! local-terminal decision relayed by the plugin (`local_decision`). The socket
//! reads/writes, the TLS handshake, the routing-table mutex, and the reconnect
//! supervision are deliberately excluded here — they are IO and shared state, not
//! the per-message CPU cost, and are covered by the daemon's integration tests
//! and the e2e suite.
//!
//! Payloads come from `support`; where a group isolates a later stage (building
//! the envelope), the input is parsed once outside the timed loop. The corpus
//! mirrors the plugin bench corpus so the two ends of the IPC channel are charted
//! over the same request shapes.

use std::hint::black_box;

use allowlister_remote_daemon::{build_create_msg, decision_target, local_decision};
use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};
use serde_json::Value;

#[path = "support/mod.rs"]
mod support;

use support::{create_msgs, inbound_frames, local_lines, REQUEST_ID};

/// Parse the plugin's `create` line off the wire (the JSON scan the daemon runs
/// before it can build the broker envelope).
fn bench_parse_create(c: &mut Criterion) {
    let mut group = c.benchmark_group("parse_create");
    for (name, msg) in create_msgs() {
        group.bench_with_input(BenchmarkId::from_parameter(name), &msg, |b, msg| {
            b.iter(|| serde_json::from_str::<Value>(black_box(msg)));
        });
    }
    group.finish();
}

/// Build the broker `create` envelope from a pre-parsed plugin message: stamp the
/// id and re-serialize. Parsing is hoisted out of the timer so this group charts
/// only the envelope construction.
fn bench_build_create_msg(c: &mut Criterion) {
    let mut group = c.benchmark_group("build_create_msg");
    for (name, msg) in create_msgs() {
        let create: Value = serde_json::from_str(&msg).expect("create fixture is valid JSON");
        group.bench_with_input(BenchmarkId::from_parameter(name), &create, |b, create| {
            b.iter(|| build_create_msg(black_box(create), black_box(REQUEST_ID)));
        });
    }
    group.finish();
}

/// Extract the routing target of an inbound broker frame (parse + type/id probe),
/// the pure half of `route_decision`.
fn bench_decision_target(c: &mut Criterion) {
    let mut group = c.benchmark_group("decision_target");
    for (name, frame) in inbound_frames() {
        group.bench_with_input(BenchmarkId::from_parameter(name), &frame, |b, frame| {
            b.iter(|| decision_target(black_box(frame)));
        });
    }
    group.finish();
}

/// Parse a local-terminal decision line relayed by the plugin.
fn bench_local_decision(c: &mut Criterion) {
    let mut group = c.benchmark_group("local_decision");
    for (name, line) in local_lines() {
        group.bench_with_input(BenchmarkId::from_parameter(name), &line, |b, line| {
            b.iter(|| local_decision(black_box(line)));
        });
    }
    group.finish();
}

criterion_group!(
    benches,
    bench_parse_create,
    bench_build_create_msg,
    bench_decision_target,
    bench_local_decision
);
criterion_main!(benches);
