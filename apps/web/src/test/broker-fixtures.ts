// Raw broker payloads for unit tests: the verbatim allowlister protocol-v3 wire
// shape the daemon announces over the broker (snake_case fields plus the
// daemon-assigned `id`), which `normalizeBrokerRequest` turns into the rendered
// ApprovalRequest. These mirror the normalized `demoRequests` in `../fixtures`
// so the inbox tests assert against the same data the app shows in production,
// but exercise the real broker → normalize → render path rather than a
// pre-normalized shortcut.
export const brokerRequestPayloads: unknown[] = [
  {
    id: "demo-oneoff",
    protocol_version: 3,
    subject: "shell",
    harness: "codex",
    cwd: "/workspace/acme-api",
    command: "gh pr merge 42 --squash --delete-branch",
    current_verdict: "defer",
    current_reason: "no rule matched `gh pr merge 42 --squash --delete-branch` (standalone)",
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
  {
    id: "demo-release-script",
    protocol_version: 3,
    subject: "shell",
    harness: "claude-code",
    session_id: "9f3c1a2b7e4d",
    cwd: "/workspace/acme-api",
    command:
      "set -euo pipefail\nnpm run build\nfor attempt in $(seq 1 30); do\n  curl -fsS https://api.acme.dev/healthz\n  sleep 10\ndone\nnpm publish --access public\ngit push origin main --tags",
    current_verdict: "ask",
    current_reason:
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
  {
    id: "demo-tool-mcp",
    protocol_version: 3,
    subject: "tool",
    harness: "claude-code",
    session_id: "9f3c1a2b7e4d",
    cwd: "/workspace/acme-api",
    current_verdict: "defer",
    current_reason: "no rule matched tool `mcp__github__create_issue`",
    tool: {
      name: "mcp__github__create_issue",
      capability: "mcp",
      params: { mcp_server: "github", mcp_tool: "create_issue" },
      raw: { owner: "acme", repo: "app", title: "Production is down", body: "sev1" },
    },
  },
  {
    id: "demo-tool-write",
    protocol_version: 3,
    subject: "tool",
    harness: "codex",
    cwd: "/workspace/acme-api",
    current_verdict: "defer",
    current_reason: "no rule matched tool `write`",
    tool: {
      name: "write",
      capability: "write",
      params: { path: "/repo/.github/workflows/deploy.yml" },
      raw: { path: "/repo/.github/workflows/deploy.yml" },
    },
  },
];
