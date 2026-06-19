//! Criterion micro-benchmarks for the plugin's pure, network-free decision path.
//!
//! These measure the in-process work a single plugin invocation does between
//! reading its stdin payload and touching the network: parse the harness JSON
//! and triage a static verdict (`triage`), build the create-request body
//! (`build_create_body`), interpret a poll response (`interpret_decision`), and
//! map a line typed at the terminal (`parse_local_input`). Process startup,
//! HTTP, and terminal I/O are deliberately excluded here — `scripts/bench.sh`
//! covers the no-network CLI cost end to end with hyperfine, and the full remote
//! round-trip is covered by the e2e suite.
//!
//! Payloads come from `support::corpus`, parsed once outside every timed loop
//! where a group isolates a later stage. The corpus is intentionally small and
//! realistic; the `triage_scaling` group charts how parse + build cost grows
//! with command length using `&&` chains of increasing length.

use std::hint::black_box;

use allowlister_remote_plugin::{
    build_create_body, interpret_decision, parse_local_input, static_decision, triage,
};
use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};
use serde_json::Value;

#[path = "support/mod.rs"]
mod support;

use support::{chain, corpus, decision_bodies, local_inputs, payload};

/// The default (wait-indefinitely) timeout the binary passes; held constant so
/// the benches isolate parsing and body construction, not arithmetic.
const TIMEOUT_MS: u64 = 0;

fn bench_triage(c: &mut Criterion) {
    let mut group = c.benchmark_group("triage");
    for (name, body) in corpus() {
        group.bench_with_input(BenchmarkId::from_parameter(name), &body, |b, body| {
            b.iter(|| triage(black_box(body), black_box(TIMEOUT_MS)));
        });
    }
    group.finish();
}

/// The hot, no-UI path: the binary probes `current_verdict` on every invocation
/// and short-circuits a static allow/deny to `defer` without building the full
/// payload tree. Benched over the whole corpus so the static case (the
/// short-circuit) and the defer cases (the probe that then falls through to the
/// network path) are both visible.
fn bench_static_decision(c: &mut Criterion) {
    let mut group = c.benchmark_group("static_decision");
    for (name, body) in corpus() {
        group.bench_with_input(BenchmarkId::from_parameter(name), &body, |b, body| {
            b.iter(|| static_decision(black_box(body)));
        });
    }
    group.finish();
}

fn bench_build_create_body(c: &mut Criterion) {
    let mut group = c.benchmark_group("build_create_body");
    for (name, body) in corpus() {
        // Parse once, outside the timer: this group isolates body construction.
        let input: Value = serde_json::from_str(&body).expect("corpus payload is valid JSON");
        group.bench_with_input(BenchmarkId::from_parameter(name), &input, |b, input| {
            b.iter(|| build_create_body(black_box(input), black_box(TIMEOUT_MS)));
        });
    }
    group.finish();
}

fn bench_interpret_decision(c: &mut Criterion) {
    let mut group = c.benchmark_group("interpret_decision");
    for (name, body) in decision_bodies() {
        group.bench_with_input(BenchmarkId::from_parameter(name), &body, |b, body| {
            b.iter(|| interpret_decision(black_box(body)));
        });
    }
    group.finish();
}

fn bench_parse_local_input(c: &mut Criterion) {
    let mut group = c.benchmark_group("parse_local_input");
    for (name, line) in local_inputs() {
        group.bench_with_input(BenchmarkId::from_parameter(name), &line, |b, line| {
            b.iter(|| parse_local_input(black_box(line)));
        });
    }
    group.finish();
}

/// How triage (parse + build) scales with command length: `&&` chains of
/// growing length, the worst case for the JSON string scan and value clone.
fn bench_triage_scaling(c: &mut Criterion) {
    let mut group = c.benchmark_group("triage_scaling/command_len");
    for len in [4usize, 32, 256] {
        let body = payload(&chain(len), "defer", None);
        group.bench_with_input(BenchmarkId::from_parameter(len), &body, |b, body| {
            b.iter(|| triage(black_box(body), black_box(TIMEOUT_MS)));
        });
    }
    group.finish();
}

criterion_group!(
    benches,
    bench_static_decision,
    bench_triage,
    bench_build_create_body,
    bench_interpret_decision,
    bench_parse_local_input,
    bench_triage_scaling
);
criterion_main!(benches);
