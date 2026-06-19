//! Link the CLI binary as a position-dependent (non-PIE) executable on Linux.
//!
//! The plugin is spawned once per command the agent harness gates, so its
//! runtime is dominated by process startup, not the tiny decision it makes:
//! profiling the no-network hot path (a static allow/deny that defers without
//! touching the server) shows ~95% of its instructions are the dynamic loader
//! and libc startup, and the single largest avoidable slice is the loader
//! applying this binary's ~5,400 `R_X86_64_RELATIVE` relocations on every run
//! because a PIE is linked at an unknown base address.
//!
//! Linking non-PIE fixes the load address at link time, so those relocations
//! are resolved by the linker once instead of by the loader on every
//! invocation. Measured with `scripts/bench-instructions.sh` (cachegrind), this
//! drops the hot-path instruction count ~16% and the relocation table from
//! ~5,500 entries to ~100. The trade-off is ASLR on the main executable's own
//! image (shared libraries such as libc stay ASLR'd); acceptable for a
//! short-lived, locally-spawned approval helper where per-invocation latency is
//! the priority.
//!
//! `rustc-link-arg-bins` scopes the flag to this crate's binary target only, so
//! proc-macro and build-script `.so`s — which must stay `-shared` and reject
//! `-no-pie` — are untouched, as are the lib, tests, and benches. Restricted to
//! the Linux **glibc** target: a glibc binary is dynamically linked and PIE, so
//! `-no-pie` is what removes its load-time relocations. A static musl build is
//! already non-PIE and relocation-free, and forcing `-no-pie` onto its static
//! CRT crashes startup — so it is left alone. macOS and Windows mandate/expect
//! position-independent images and have no equivalent flag.

fn main() {
    println!("cargo:rerun-if-changed=build.rs");

    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_os == "linux" && target_env == "gnu" {
        println!("cargo::rustc-link-arg-bins=-no-pie");
    }
}
