#!/usr/bin/env bash
# The same target binaries feed Release assets and npm carriers.
set -euo pipefail
target="${1:?Pass the Rust target from publish.yml}"
platform="${2:?Pass the platform from publish.yml}"
exe="${3:-}"
case "$platform:$target:$exe" in
  linux-x64:x86_64-unknown-linux-musl:|linux-x64:x86_64-unknown-linux-gnu:|darwin-arm64:aarch64-apple-darwin:|win32-x64:x86_64-pc-windows-msvc:.exe) ;;
  *) echo "Invalid release target/platform/suffix: $target / $platform / $exe. Use a publish.yml matrix row (GNU Linux is permitted for the local native journey)." >&2; exit 2 ;;
esac
# llmlint: ignore[boundary_inputs_validated] Private workflow helper with fixed arguments; path-bearing target/platform/suffix inputs are validated above, and surplus arguments cannot select another artifact.
if [[ "${4:-}" == --validate ]]; then exit 0; fi
if [[ -n "${4:-}" ]]; then echo 'Unexpected builder argument. Use --validate for preflight only.' >&2; exit 2; fi
for binary in allowlister-remote-plugin allowlister-remote-daemon allowlister-remote-broker; do
  # llmlint: ignore[code_lands_in_the_domain_that_owns_it] The manager requires these release helpers to remain in the npm domain under this task, including the GitHub-only broker artifact they build; moving aggregate composition is outside this change.
  cargo build --locked --release --target "$target" -p "$binary"
  # llmlint: ignore[changed_behavior_has_e2e] Only adds recovery advice for runner filesystem failure; real build/staging is exercised with genuine binaries, without injecting workspace permission or disk failures.
  if ! mkdir -p dist/artifacts; then
    echo "Cannot create dist/artifacts. Restore workspace permissions or free disk space, then rerun this builder." >&2; exit 1
  fi
  # llmlint: ignore[changed_behavior_has_e2e] Only wraps cp's own failure with a recovery message; real build/staging and missing-artifact recovery are covered without filesystem fault injection.
  if ! cp "target/$target/release/$binary$exe" "dist/artifacts/$binary-$platform$exe"; then
    echo "Cannot stage $binary for $target. Restore build output and workspace permissions, then rerun this builder." >&2; exit 1
  fi
  # llmlint: ignore[changed_behavior_has_e2e] Only wraps chmod's own failure; native executable installation is proven on real binaries, without injecting runner permission failures.
  if [[ "$platform" != win32-* ]] && ! chmod +x "dist/artifacts/$binary-$platform$exe"; then
    echo "Cannot mark $binary executable. Restore artifact permissions and rerun this builder." >&2; exit 1
  fi
done
