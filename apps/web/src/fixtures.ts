import type { ApprovalRequest } from "./types";

export const demoRequests: ApprovalRequest[] = [
  {
    id: "demo-deploy-1",
    subject: "shell",
    harness: "codex",
    cwd: "/workspace/acme-api",
    command:
      "git diff --stat && npm test && gh pr merge 42 --squash --delete-branch",
    currentVerdict: "ask",
    currentReason:
      "`gh pr merge` matched allowlister rule 'GitHub write operations require approval'",
    createdAt: new Date(Date.now() - 42_000).toISOString(),
    expiresAt: new Date(Date.now() + 118_000).toISOString(),
    fragments: [
      {
        argv: ["git", "diff", "--stat"],
        display: "git diff --stat",
        role: "standalone",
        verdict: "allow",
        rule: "git read-only",
      },
      {
        argv: ["npm", "test"],
        display: "npm test",
        role: "standalone",
        verdict: "allow",
        rule: "project checks",
      },
      {
        argv: ["gh", "pr", "merge", "42", "--squash", "--delete-branch"],
        display: "gh pr merge 42 --squash --delete-branch",
        role: "standalone",
        verdict: "ask",
        rule: "GitHub write operations require approval",
      },
    ],
    riskSignals: ["GitHub write", "branch deletion", "merge action"],
  },
];
