//! Deterministic allocation report for the broker's pure protocol path.
//!
//! Not a statistical benchmark: a counting global allocator tallies allocator
//! calls and requested bytes for one parse+dispatch per inbound frame and one
//! build per outbound envelope (including snapshots over a growing pending set),
//! then prints a markdown table. The counts are exact and stable for a given
//! commit, so two runs are directly comparable — in CI or by eye — without
//! warmups or statistics. They surface allocator pressure the wall-clock numbers
//! in `benches/protocol.rs` cannot attribute.
//!
//! `harness = false` with a plain `main` keeps libtest, Criterion, nextest, and
//! coverage away from this target (it is measured, not gated). The `--bench`
//! argument cargo passes is deliberately ignored.

use std::alloc::{GlobalAlloc, Layout, System};
use std::hint::black_box;
use std::sync::atomic::{AtomicU64, Ordering};

use allowlister_remote_broker::{
    added_message, decision_message, message_kind, resolved_message, snapshot_message,
};
use serde_json::Value;

#[path = "support/mod.rs"]
mod support;

use support::{inbound_frames, request, requests};

/// The system allocator wrapped with relaxed atomic tallies. A `realloc` counts
/// as one call plus only the grown bytes, so `BYTES` tracks total memory
/// requested without double-counting moves; frees are not tracked.
struct CountingAlloc;

static CALLS: AtomicU64 = AtomicU64::new(0);
static BYTES: AtomicU64 = AtomicU64::new(0);

unsafe impl GlobalAlloc for CountingAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        CALLS.fetch_add(1, Ordering::Relaxed);
        BYTES.fetch_add(layout.size() as u64, Ordering::Relaxed);
        System.alloc(layout)
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout)
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        CALLS.fetch_add(1, Ordering::Relaxed);
        BYTES.fetch_add(
            new_size.saturating_sub(layout.size()) as u64,
            Ordering::Relaxed,
        );
        System.realloc(ptr, layout, new_size)
    }
}

#[global_allocator]
static ALLOC: CountingAlloc = CountingAlloc;

/// Allocator calls and bytes requested while running `f` (including dropping its
/// result).
fn measure<T>(f: impl FnOnce() -> T) -> (u64, u64) {
    let calls = CALLS.load(Ordering::Relaxed);
    let bytes = BYTES.load(Ordering::Relaxed);
    black_box(f());
    (
        CALLS.load(Ordering::Relaxed) - calls,
        BYTES.load(Ordering::Relaxed) - bytes,
    )
}

/// Parse a frame and classify it — one inbound message's pure work.
fn parse_dispatch(frame: &str) {
    let value: Value = serde_json::from_str(frame).expect("frame fixture is valid JSON");
    black_box(message_kind(&value));
}

fn main() {
    let req = request("req_1", "gh pr merge 42");
    let snapshots: Vec<(usize, Vec<Value>)> = [1usize, 8, 64]
        .into_iter()
        .map(|n| (n, requests(n)))
        .collect();

    // Flush lazy one-time initialization out of the measured calls.
    for (_, frame) in inbound_frames() {
        parse_dispatch(&frame);
    }
    black_box(added_message(&req));
    for (_, pending) in &snapshots {
        let refs: Vec<&Value> = pending.iter().collect();
        black_box(snapshot_message(&refs));
    }

    println!("| operation | case | allocator calls | bytes requested |");
    println!("|---|---|---:|---:|");
    for (name, frame) in inbound_frames() {
        let (calls, bytes) = measure(|| parse_dispatch(&frame));
        println!("| parse_dispatch | {name} | {calls} | {bytes} |");
    }
    let (calls, bytes) = measure(|| added_message(&req));
    println!("| added_message | request | {calls} | {bytes} |");
    let (calls, bytes) = measure(|| resolved_message("req_1"));
    println!("| resolved_message | request | {calls} | {bytes} |");
    let (calls, bytes) = measure(|| decision_message("req_1", "allow", "approved in the web app"));
    println!("| decision_message | request | {calls} | {bytes} |");
    for (n, pending) in &snapshots {
        let refs: Vec<&Value> = pending.iter().collect();
        let (calls, bytes) = measure(|| snapshot_message(&refs));
        println!("| snapshot_message | pending={n} | {calls} | {bytes} |");
    }
}
