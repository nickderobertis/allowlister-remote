// Raw broker payloads for unit tests and the visual-docs capture: the verbatim
// allowlister protocol-v3 wire shape the daemon announces over the broker
// (snake_case fields plus the daemon-assigned `id`), which
// `normalizeBrokerRequest` turns into the rendered ApprovalRequest. These mirror
// the normalized `demoRequests` in `../fixtures` field-for-field so the inbox
// tests and the screenshots assert against the same data the app shows in
// production, but exercise the real broker → normalize → render path rather than
// a pre-normalized shortcut.
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
      "set -euo pipefail\nnpm run build\nfor region in $(cat deploy/regions.txt); do\n  curl -fsS https://api.acme.dev/$region/healthz\n  kubectl --context $region apply -f deploy/manifest.yaml\ndone\ngit push origin main --tags",
    current_verdict: "ask",
    current_reason:
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
