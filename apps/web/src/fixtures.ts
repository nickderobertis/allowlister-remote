import type { ApprovalRequest } from "./types";

// These fixtures are transcribed from real allowlister v0.5.4 (protocol v3)
// plugin payloads captured by running `allowlister check --json` against sample
// commands, scripts, and a config — so the unit tests, benchmarks, and
// screenshots reflect the actual wire data, not invented shapes. Only the
// harness names, session ids,
// and working directories are dressed up to read like a real project. Protocol
// v3 carries the harness `session_id`; harnesses that do not expose one (here,
// codex) omit it, which the app renders as "no session".
export const demoRequests: ApprovalRequest[] = [
  // A one-off command that matched no rule, so allowlister defers the whole
  // thing to the remote plugin: a single standalone fragment.
  {
    id: "demo-oneoff",
    protocolVersion: 3,
    subject: "shell",
    harness: "codex",
    sessionId: null,
    cwd: "/workspace/acme-api",
    command: "gh pr merge 42 --squash --delete-branch",
    currentVerdict: "defer",
    currentReason: "no rule matched `gh pr merge 42 --squash --delete-branch` (standalone)",
    fragments: [
      {
        display: "gh pr merge 42 --squash --delete-branch",
        argv: ["gh", "pr", "merge", "42", "--squash", "--delete-branch"],
        role: "standalone",
        verdict: "defer",
        rule: null,
        reason: "no matching rule",
      },
    ],
  },
  // A multi-line build-and-deploy script with a `for` loop that rolls each region
  // out in turn. Most fragments are allowed by static rules — including the
  // `$(cat …)` command substitution in the loop header and the health probe in the
  // loop body — but the `kubectl apply` inside the loop and the trailing
  // `git push` trip an `ask`, so the operator approves those two actions, not the
  // wall of shell. One of the flagged commands lives in the loop body, so the web
  // "Script" view and the terminal prompt both have to surface a command nested
  // inside the `for … do` block. Fragment `display`s are the trimmed command; the
  // Script view reconstructs the loop's indentation from the raw command instead.
  {
    id: "demo-release-script",
    protocolVersion: 3,
    subject: "shell",
    harness: "claude-code",
    sessionId: "9f3c1a2b7e4d",
    cwd: "/workspace/acme-api",
    command:
      "set -euo pipefail\nnpm run build\nfor region in $(cat deploy/regions.txt); do\n  curl -fsS https://api.acme.dev/$region/healthz\n  kubectl --context $region apply -f deploy/manifest.yaml\ndone\ngit push origin main --tags",
    currentVerdict: "ask",
    currentReason:
      "2 commands need approval: `kubectl --context $region apply -f deploy/manifest.yaml` (loop body): needs approval per rule 'ask before applying kubernetes manifests'; `git push origin main --tags` (standalone): needs approval per rule 'ask before pushing to a remote'",
    fragments: [
      {
        display: "set -euo pipefail",
        argv: ["set", "-euo", "pipefail"],
        role: "standalone",
        verdict: "allow",
        rule: "allow set builtins",
        reason: "allowed by 'allow set builtins'",
      },
      {
        display: "npm run build",
        argv: ["npm", "run", "build"],
        role: "standalone",
        verdict: "allow",
        rule: "allow npm scripts",
        reason: "allowed by 'allow npm scripts'",
      },
      {
        display: "cat deploy/regions.txt",
        argv: ["cat", "deploy/regions.txt"],
        role: "substitution",
        verdict: "allow",
        rule: "allow coreutils",
        reason: "allowed by 'allow coreutils'",
      },
      {
        display: "curl -fsS https://api.acme.dev/$region/healthz",
        argv: ["curl", "-fsS", "https://api.acme.dev/$region/healthz"],
        role: "loop_body",
        verdict: "allow",
        rule: "allow health-check probes",
        reason: "allowed by 'allow health-check probes'",
      },
      {
        display: "kubectl --context $region apply -f deploy/manifest.yaml",
        argv: ["kubectl", "--context", "$region", "apply", "-f", "deploy/manifest.yaml"],
        role: "loop_body",
        verdict: "ask",
        rule: "ask before applying kubernetes manifests",
        reason: "needs approval per rule 'ask before applying kubernetes manifests'",
      },
      {
        display: "git push origin main --tags",
        argv: ["git", "push", "origin", "main", "--tags"],
        role: "standalone",
        verdict: "ask",
        rule: "ask before pushing to a remote",
        reason: "needs approval per rule 'ask before pushing to a remote'",
      },
    ],
  },
  // A non-shell tool call: an MCP write to GitHub. The plugin sees the canonical
  // params and the verbatim raw input, which the app shows in formatted and JSON
  // views.
  {
    id: "demo-tool-mcp",
    protocolVersion: 3,
    subject: "tool",
    harness: "claude-code",
    sessionId: "9f3c1a2b7e4d",
    cwd: "/workspace/acme-api",
    currentVerdict: "defer",
    currentReason: "no rule matched tool `mcp__github__create_issue`",
    tool: {
      name: "mcp__github__create_issue",
      capability: "mcp",
      params: { mcp_server: "github", mcp_tool: "create_issue" },
      raw: {
        owner: "acme",
        repo: "app",
        title: "Production is down",
        body: "sev1",
      },
    },
  },
  // A capability tool call: a file write to a sensitive path.
  {
    id: "demo-tool-write",
    protocolVersion: 3,
    subject: "tool",
    harness: "codex",
    sessionId: null,
    cwd: "/workspace/acme-api",
    currentVerdict: "defer",
    currentReason: "no rule matched tool `write`",
    tool: {
      name: "write",
      capability: "write",
      params: { path: "/repo/.github/workflows/deploy.yml" },
      raw: { path: "/repo/.github/workflows/deploy.yml" },
    },
  },
];
