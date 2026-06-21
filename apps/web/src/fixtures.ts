import type { ApprovalRequest } from "./types";

// These fixtures are transcribed from real allowlister v0.5.4 (protocol v3)
// plugin payloads captured by running `allowlister check --json` against sample
// commands, scripts, and a config — so the demo and screenshots reflect the
// actual wire data, not invented shapes. Only the harness names, session ids,
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
  // A multi-line deploy-and-release script with a `for` loop that long-polls the
  // health endpoint between build and publish. Most fragments are allowed by
  // static rules — including the indented loop body and the `$(seq …)` command
  // substitution in the loop header — and only two, `npm publish` and `git push`,
  // trip an `ask`, so the operator approves the action, not the wall of shell.
  // The loop body fragments keep their source indentation in `display` so both the
  // web "Script" view and the terminal prompt show how a nested script renders.
  {
    id: "demo-release-script",
    protocolVersion: 3,
    subject: "shell",
    harness: "claude-code",
    sessionId: "9f3c1a2b7e4d",
    cwd: "/workspace/acme-api",
    command:
      "set -euo pipefail\nnpm run build\nfor attempt in $(seq 1 30); do\n  curl -fsS https://api.acme.dev/healthz\n  sleep 10\ndone\nnpm publish --access public\ngit push origin main --tags",
    currentVerdict: "ask",
    currentReason:
      "2 commands need approval: `npm publish --access public` (standalone): needs approval per rule 'ask before publishing a package'; `git push origin main --tags` (standalone): needs approval per rule 'ask before pushing to a remote'",
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
        display: "seq 1 30",
        argv: ["seq", "1", "30"],
        role: "substitution",
        verdict: "allow",
        rule: "allow coreutils",
        reason: "allowed by 'allow coreutils'",
      },
      {
        display: "  curl -fsS https://api.acme.dev/healthz",
        argv: ["curl", "-fsS", "https://api.acme.dev/healthz"],
        role: "loop_body",
        verdict: "allow",
        rule: "allow health-check probes",
        reason: "allowed by 'allow health-check probes'",
      },
      {
        display: "  sleep 10",
        argv: ["sleep", "10"],
        role: "loop_body",
        verdict: "allow",
        rule: "allow sleep",
        reason: "allowed by 'allow sleep'",
      },
      {
        display: "npm publish --access public",
        argv: ["npm", "publish", "--access", "public"],
        role: "standalone",
        verdict: "ask",
        rule: "ask before publishing a package",
        reason: "needs approval per rule 'ask before publishing a package'",
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
