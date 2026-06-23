//! Criterion micro-benchmarks for the broker's pure, network-free protocol path.
//!
//! These measure the in-process work the broker does per message between its two
//! WebSocket edges: parse an inbound frame (`serde_json::from_str` +
//! `message_kind`, the dispatch key), and build each outbound wire envelope it
//! fans out — `added_message` (a new pending request), `resolved_message` (a
//! dismissal), `decision_message` (a web decision routed to the owning daemon),
//! and `snapshot_message` (the pending set a newly-subscribed PWA receives). The
//! sockets, the heartbeat pings, the per-connection mpsc pumps, and the routing
//! mutex are deliberately excluded here — they are IO and shared state, not the
//! per-message CPU cost, and are covered by the broker's integration tests and
//! the e2e suite.
//!
//! The `snapshot_scaling` group charts how snapshot serialization grows with the
//! pending count, the one broker output whose size is unbounded.

use std::hint::black_box;

use allowlister_remote_broker::{
    added_message, decision_message, message_kind, resolved_message, snapshot_message,
};
use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};
use serde_json::Value;

#[path = "support/mod.rs"]
mod support;

use support::{inbound_frames, request, requests};

/// Parse an inbound frame off the wire and classify its type — the first work the
/// broker does to route any message.
fn bench_parse_dispatch(c: &mut Criterion) {
    let mut group = c.benchmark_group("parse_dispatch");
    for (name, frame) in inbound_frames() {
        group.bench_with_input(BenchmarkId::from_parameter(name), &frame, |b, frame| {
            b.iter(|| {
                let value: Value =
                    serde_json::from_str(black_box(frame)).expect("frame fixture is valid JSON");
                black_box(message_kind(&value));
            });
        });
    }
    group.finish();
}

/// Build the `added` envelope fanned out to PWAs on every new request (parse the
/// request body once, outside the timer).
fn bench_added_message(c: &mut Criterion) {
    let req = request("req_1", "gh pr merge 42");
    c.bench_function("added_message", |b| {
        b.iter(|| added_message(black_box(&req)));
    });
}

/// Build the `resolved` dismissal and the `decision` routed back to a daemon.
fn bench_resolution_messages(c: &mut Criterion) {
    c.bench_function("resolved_message", |b| {
        b.iter(|| resolved_message(black_box("req_1")));
    });
    c.bench_function("decision_message", |b| {
        b.iter(|| {
            decision_message(
                black_box("req_1"),
                black_box("allow"),
                black_box("approved in the web app"),
            )
        });
    });
}

/// How snapshot serialization scales with the pending count — the only broker
/// output whose size is unbounded (a PWA subscribing to a busy broker).
fn bench_snapshot_scaling(c: &mut Criterion) {
    let mut group = c.benchmark_group("snapshot_scaling/pending");
    for n in [1usize, 8, 64] {
        let pending = requests(n);
        let refs: Vec<&Value> = pending.iter().collect();
        group.bench_with_input(BenchmarkId::from_parameter(n), &refs, |b, refs| {
            b.iter(|| snapshot_message(black_box(refs)));
        });
    }
    group.finish();
}

criterion_group!(
    benches,
    bench_parse_dispatch,
    bench_added_message,
    bench_resolution_messages,
    bench_snapshot_scaling
);
criterion_main!(benches);
