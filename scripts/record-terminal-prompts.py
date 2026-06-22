#!/usr/bin/env python3
"""Record the plugin's REAL `/dev/tty` approval prompt into a committed fixture.

This is a developer tool, not part of the CI capture. It builds nothing: it
expects the plugin binary to already exist, runs it under a controlling PTY (so
`/dev/tty` opens) against a tiny stub server, and writes the exact bytes it
prints to `apps/web/screenshots/terminal/prompts.json`. That fixture is what the
visual-docs capture renders to SVG, and `tests/terminal_prompt.rs` asserts the
live binary still reproduces it — so the gallery can never drift from the real
terminal UX. Re-run this whenever the prompt wording in `local_prompt` changes:

    cargo build -p allowlister-remote-plugin --bin allowlister-remote-plugin
    python3 scripts/record-terminal-prompts.py

A non-200 on the decision poll keeps the request pending (a human who has not
decided yet); `cwd:` in the prompt comes from the payload's `cwd` field, not the
process cwd, so it is fully pinned.
"""

from __future__ import annotations

import fcntl
import json
import os
import select
import signal
import termios
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PLUGIN = REPO / "target/debug/allowlister-remote-plugin"
FIXTURE = REPO / "apps/web/screenshots/terminal/prompts.json"

# Each entry pins the `command` (what the prompt's "command:" line shows — the
# shell command, or for a tool call the tool name) and `cwd`, plus the payload
# that elicits exactly that. These mirror the web gallery's shell and tool cards.
SCENARIOS = [
    {
        "name": "terminal-shell",
        "command": "gh pr merge 42 --squash --delete-branch",
        "cwd": "~/src/allowlister-remote",
        "payload": {
            "protocol_version": 3,
            "subject": "shell",
            "current_verdict": "defer",
            "command": "gh pr merge 42 --squash --delete-branch",
            "cwd": "~/src/allowlister-remote",
            # A single standalone fragment that matched no rule: the prompt
            # surfaces it under "needs your attention" with no rule line.
            "fragments": [
                {
                    "display": "gh pr merge 42 --squash --delete-branch",
                    "argv": ["gh", "pr", "merge", "42", "--squash", "--delete-branch"],
                    "role": "standalone",
                    "verdict": "defer",
                    "rule": None,
                    "reason": "no matching rule",
                }
            ],
        },
    },
    {
        "name": "terminal-tool",
        "command": "mcp__github__create_issue",
        "cwd": "~/src/allowlister-remote",
        "payload": {
            "protocol_version": 3,
            "subject": "tool",
            "current_verdict": "defer",
            "tool": {"name": "mcp__github__create_issue", "capability": "mcp"},
            "cwd": "~/src/allowlister-remote",
        },
    },
    {
        # The terminal twin of the web gallery's `shell-script` card: a deploy
        # script whose `for` loop rolls out each region, where the `kubectl apply`
        # inside the loop and the trailing `git push` tripped the gate. The prompt
        # surfaces just those two fragments under "needs your attention" (each with
        # the rule that flagged it) — one of them nested in the loop body — then
        # prints the whole multi-line command verbatim under "full command", so the
        # operator approves the action, not the wall of shell, exactly as the web
        # app does.
        "name": "terminal-script",
        "command": (
            "set -euo pipefail\nnpm run build\nfor region in $(cat deploy/regions.txt); do\n"
            "  curl -fsS https://api.acme.dev/$region/healthz\n"
            "  kubectl --context $region apply -f deploy/manifest.yaml\ndone\n"
            "git push origin main --tags"
        ),
        "cwd": "/workspace/acme-api",
        "payload": {
            "protocol_version": 3,
            "subject": "shell",
            "current_verdict": "ask",
            "command": (
                "set -euo pipefail\nnpm run build\nfor region in $(cat deploy/regions.txt); do\n"
                "  curl -fsS https://api.acme.dev/$region/healthz\n"
                "  kubectl --context $region apply -f deploy/manifest.yaml\ndone\n"
                "git push origin main --tags"
            ),
            "cwd": "/workspace/acme-api",
            # Mirrors the web gallery's deploy-script decomposition: the health
            # probe and the `$(cat …)` substitution are allowed by static rules,
            # and the loop body's `kubectl apply` and the standalone `git push`
            # trip an `ask`, so only those two are flagged.
            "fragments": [
                {"display": "set -euo pipefail", "argv": ["set", "-euo", "pipefail"], "role": "standalone", "verdict": "allow", "rule": "allow set builtins", "reason": "allowed by 'allow set builtins'"},
                {"display": "npm run build", "argv": ["npm", "run", "build"], "role": "standalone", "verdict": "allow", "rule": "allow npm scripts", "reason": "allowed by 'allow npm scripts'"},
                {"display": "cat deploy/regions.txt", "argv": ["cat", "deploy/regions.txt"], "role": "substitution", "verdict": "allow", "rule": "allow coreutils", "reason": "allowed by 'allow coreutils'"},
                {"display": "curl -fsS https://api.acme.dev/$region/healthz", "argv": ["curl", "-fsS", "https://api.acme.dev/$region/healthz"], "role": "loop_body", "verdict": "allow", "rule": "allow health-check probes", "reason": "allowed by 'allow health-check probes'"},
                {"display": "kubectl --context $region apply -f deploy/manifest.yaml", "argv": ["kubectl", "--context", "$region", "apply", "-f", "deploy/manifest.yaml"], "role": "loop_body", "verdict": "ask", "rule": "ask before applying kubernetes manifests", "reason": "needs approval per rule 'ask before applying kubernetes manifests'"},
                {"display": "git push origin main --tags", "argv": ["git", "push", "origin", "main", "--tags"], "role": "standalone", "verdict": "ask", "rule": "ask before pushing to a remote", "reason": "needs approval per rule 'ask before pushing to a remote'"},
            ],
        },
    },
]


def capture_prompt(payload: dict) -> str:
    """Run the real plugin under a PTY and return its prompt, CR-LF normalized
    and with the bracketing blank lines trimmed to the content block."""
    reply = json.dumps({"id": "record"}).encode()

    class Stub(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", 0)))
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(reply)))
            self.end_headers()
            self.wfile.write(reply)

        def do_GET(self):
            self.send_response(404)
            self.end_headers()

    server = ThreadingHTTPServer(("127.0.0.1", 0), Stub)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()

    master_fd, slave_fd = os.openpty()
    stdin_r, stdin_w = os.pipe()
    err_r, err_w = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.setsid()
        fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
        os.dup2(stdin_r, 0)
        os.dup2(slave_fd, 1)
        os.dup2(err_w, 2)
        for fd in (master_fd, slave_fd, stdin_r, stdin_w, err_r, err_w):
            try:
                os.close(fd)
            except OSError:
                pass
        os.execv(
            str(PLUGIN),
            [str(PLUGIN), "--server-url", f"http://127.0.0.1:{port}", "--poll-ms", "500"],
        )
        os._exit(127)

    os.close(slave_fd)
    os.close(stdin_r)
    os.close(err_w)
    os.write(stdin_w, json.dumps(payload).encode())
    os.close(stdin_w)

    out = b""
    err = b""
    deadline = time.time() + 8
    while time.time() < deadline:
        ready, _, _ = select.select([master_fd, err_r], [], [], 0.3)
        for fd in ready:
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                chunk = b""
            if fd == master_fd:
                out += chunk
            else:
                err += chunk
        if b"[a]llow / [d]eny:" in out:
            ready, _, _ = select.select([master_fd], [], [], 0.2)
            if master_fd in ready:
                out += os.read(master_fd, 4096)
            break

    os.kill(pid, signal.SIGKILL)
    os.waitpid(pid, 0)
    server.shutdown()
    if err.strip():
        raise SystemExit(f"plugin error during capture: {err!r}")
    if b"[a]llow / [d]eny:" not in out:
        raise SystemExit(f"never saw the approval prompt; captured: {out!r}")
    return out.decode("utf-8", "replace").replace("\r\n", "\n").replace("\r", "")


def main() -> None:
    if not PLUGIN.exists():
        raise SystemExit(
            f"plugin binary missing at {PLUGIN}; build it first:\n"
            "  cargo build -p allowlister-remote-plugin --bin allowlister-remote-plugin"
        )
    prompts = []
    for scenario in SCENARIOS:
        prompt = capture_prompt(scenario["payload"]).strip("\n")
        prompts.append(
            {
                "name": scenario["name"],
                "command": scenario["command"],
                "cwd": scenario["cwd"],
                # The fragments the binary saw, persisted so the Rust guard
                # (tests/terminal_prompt.rs) can re-derive the flagged set and
                # rebuild this exact prompt from `local_prompt`. Only the fields
                # the guard reads are kept (display/verdict/rule) — no string
                # arrays, so the recorder's json.dumps output stays Biome-clean.
                "fragments": [
                    {
                        "display": fragment["display"],
                        "verdict": fragment["verdict"],
                        "rule": fragment["rule"],
                    }
                    for fragment in scenario["payload"].get("fragments", [])
                ],
                "prompt": prompt,
            }
        )
        print(f"recorded {scenario['name']}: {prompt!r}")
    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE.write_text(json.dumps({"schema": 1, "prompts": prompts}, indent=2) + "\n")
    print(f"wrote {FIXTURE.relative_to(REPO)}")


if __name__ == "__main__":
    main()
