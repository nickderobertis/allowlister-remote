#!/usr/bin/env bash
set -euo pipefail

# Smoke-test the staged @nickderobertis/allowlister-remote-web package locally:
# pack it, install it into a throwaway prefix, run the bundled server, and assert
# it serves the PWA and the service worker.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pkg_dir="$repo_root/packages/allowlister-remote-web"
static_index="$pkg_dir/static/index.html"

if [[ ! -f "$static_index" ]]; then
  echo "error: web package is not staged (missing $static_index)" >&2
  echo "       run: node scripts/stage-web-package.mjs <version> first" >&2
  exit 1
fi

tmp="$(mktemp -d)"
server_pid=""
cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT

echo "packing $pkg_dir ..."
tarball="$(cd "$tmp" && npm pack "$pkg_dir" --silent)"

echo "installing into $tmp ..."
npm install -g --prefix "$tmp" "$tmp/$tarball" >/dev/null 2>&1

bin="$tmp/bin/allowlister-remote-web"
if [[ ! -x "$bin" ]]; then
  echo "error: installed bin not found at $bin" >&2
  exit 1
fi

echo "starting server on 127.0.0.1:8799 ..."
PORT=8799 HOST=127.0.0.1 "$bin" &
server_pid=$!

base="http://127.0.0.1:8799"
ready=""
for _ in $(seq 1 20); do
  status="$(curl -s -o /dev/null -w "%{http_code}" "$base/" || true)"
  if [[ "$status" == "200" ]]; then
    ready="yes"
    break
  fi
  sleep 0.5
done

if [[ -z "$ready" ]]; then
  echo "error: server did not return HTTP 200 at $base/" >&2
  exit 1
fi

body="$(curl -s "$base/")"
if [[ -z "$body" ]]; then
  echo "error: response body for $base/ was empty" >&2
  exit 1
fi

sw_status="$(curl -s -o /dev/null -w "%{http_code}" "$base/sw.js" || true)"
if [[ "$sw_status" != "200" ]]; then
  echo "error: $base/sw.js returned HTTP $sw_status (expected 200)" >&2
  exit 1
fi

echo "smoke-web-package: OK"
