# AGENTS — `crates/allowlister-remote-plugin`

- `crates/allowlister-remote-plugin` is the Rust allowlister dynamic plugin client. It is
  network-free: it hands each request to the daemon over local IPC and never opens a socket
  to the broker itself.
- The `linux-x64` binary is a fully static **musl** build (`x86_64-unknown-linux-musl`, see
  `publish.yml`): it embeds libc so it carries no glibc version floor (runs on Alpine/distroless/old
  distros) and skips the dynamic loader entirely. The plugin is spawned once per gated command, so
  dropping `ld.so` cuts the no-network hot path ~75% in instruction count; the modest size cost
  (~9%) is a favorable trade. The crate's `build.rs` instead links the glibc dev binary `-no-pie`,
  which removes load-time relocations there; the static musl build is already relocation-light and
  needs no such flag.
- The plugin additionally has end-to-end **CLI** layers, because it is a
  one-shot process spawned once per gated command, so per-process startup is on
  the hot path: `just bench-cli` (hyperfine latency) and `just bench-instructions`
  (cachegrind instruction counts), see `scripts/{bench,bench-instructions}.sh`.
  These do **not** apply to the daemon and broker — they are long-lived servers,
  so per-process startup is amortized to nothing and their hot path is the
  per-message protocol work covered by their Criterion + allocation layers.
