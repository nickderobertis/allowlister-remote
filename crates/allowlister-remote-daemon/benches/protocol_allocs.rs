//! Deterministic allocation report for the daemon's pure protocol path.
//!
//! Not a statistical benchmark: a counting global allocator tallies allocator
//! calls and requested bytes for one `build_create_msg` per corpus case, one
//! `decision_target` per inbound frame, and one `local_decision` per terminal
//! line, then prints a markdown table. The counts are exact and stable for a
//! given commit, so two runs are directly comparable — in CI or by eye — without
//! warmups or statistics. They surface allocator pressure the wall-clock numbers
//! in `benches/protocol.rs` cannot attribute.
//!
//! `harness = false` with a plain `main` keeps libtest, Criterion, nextest, and
//! coverage away from this target (it is measured, not gated). The `--bench`
//! argument cargo passes is deliberately ignored.

use std::alloc::{GlobalAlloc, Layout, System};
use std::hint::black_box;
use std::sync::atomic::{AtomicU64, Ordering};

use allowlister_remote_daemon::{build_create_msg, decision_target, local_decision};
use serde_json::Value;

#[path = "support/mod.rs"]
mod support;

use support::REQUEST_ID;

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

fn main() {
    // Pre-parse the create corpus outside the measured calls; `build_create_msg`
    // is benched over a parsed `Value` so the row reflects only envelope
    // construction (matching benches/protocol.rs).
    let creates: Vec<(&str, Value)> = support::create_msgs()
        .into_iter()
        .map(|(name, msg)| {
            (
                name,
                serde_json::from_str(&msg).expect("create fixture is valid JSON"),
            )
        })
        .collect();

    // Flush lazy one-time initialization out of the measured calls.
    for (_, create) in &creates {
        black_box(build_create_msg(create, REQUEST_ID));
    }
    for (_, frame) in support::inbound_frames() {
        black_box(decision_target(frame));
    }
    for (_, line) in support::local_lines() {
        black_box(local_decision(line));
    }

    println!("| operation | case | allocator calls | bytes requested |");
    println!("|---|---|---:|---:|");
    for (name, create) in &creates {
        let (calls, bytes) = measure(|| build_create_msg(create, REQUEST_ID));
        println!("| build_create_msg | {name} | {calls} | {bytes} |");
    }
    for (name, frame) in support::inbound_frames() {
        let (calls, bytes) = measure(|| decision_target(frame));
        println!("| decision_target | {name} | {calls} | {bytes} |");
    }
    for (name, line) in support::local_lines() {
        let (calls, bytes) = measure(|| local_decision(line));
        println!("| local_decision | {name} | {calls} | {bytes} |");
    }
}
