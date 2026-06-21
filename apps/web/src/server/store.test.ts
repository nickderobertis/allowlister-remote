import { beforeEach, describe, expect, it, vi } from "vitest";
import { isShellRequest, isToolRequest } from "../types";
import {
  decideRequest,
  enqueuePluginRequest,
  getDecision,
  listPendingRequests,
  resetStore,
} from "./store";

describe("approval server store", () => {
  beforeEach(() => {
    resetStore();
    vi.useRealTimers();
  });

  it("records allowlister's structured shell fragments verbatim", () => {
    const request = enqueuePluginRequest({
      protocol_version: 3,
      subject: "shell",
      command: "npm ci\nnpm publish --access public\ngit push origin main",
      cwd: "/workspace/app",
      harness: "codex",
      session_id: "9f3c1a2b7e4d",
      current_verdict: "ask",
      current_reason: "2 commands need approval: ...",
      fragments: [
        {
          display: "npm ci",
          argv: ["npm", "ci"],
          role: "standalone",
          verdict: "allow",
          rule: "allow npm scripts",
          reason: "allowed by 'allow npm scripts'",
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
          display: "git push origin main",
          argv: ["git", "push", "origin", "main"],
          role: "standalone",
          verdict: "ask",
          rule: "ask before pushing to a remote",
          reason: "needs approval per rule 'ask before pushing to a remote'",
        },
      ],
    });

    expect(request).toMatchObject({
      subject: "shell",
      harness: "codex",
      sessionId: "9f3c1a2b7e4d",
      cwd: "/workspace/app",
      currentVerdict: "ask",
      protocolVersion: 3,
    });
    if (!isShellRequest(request)) throw new Error("expected a shell request");
    expect(request.fragments.map((fragment) => fragment.display)).toEqual([
      "npm ci",
      "npm publish --access public",
      "git push origin main",
    ]);
    expect(request.fragments.map((fragment) => fragment.verdict)).toEqual(["allow", "ask", "ask"]);
    expect(request.fragments[1]?.rule).toBe("ask before publishing a package");
  });

  it("records a tool call's canonical params and raw input", () => {
    const request = enqueuePluginRequest({
      protocol_version: 2,
      subject: "tool",
      cwd: "/workspace/app",
      harness: "claude-code",
      current_verdict: "defer",
      current_reason: "no rule matched tool `mcp__github__create_issue`",
      tool: {
        name: "mcp__github__create_issue",
        capability: "mcp",
        params: { mcp_server: "github", mcp_tool: "create_issue" },
        raw: { owner: "acme", repo: "app", title: "bug" },
      },
    });

    expect(request.subject).toBe("tool");
    if (!isToolRequest(request)) throw new Error("expected a tool request");
    expect(request.tool.name).toBe("mcp__github__create_issue");
    expect(request.tool.capability).toBe("mcp");
    expect(request.tool.params).toEqual({ mcp_server: "github", mcp_tool: "create_issue" });
    expect(request.tool.raw).toEqual({ owner: "acme", repo: "app", title: "bug" });
  });

  it("falls back to a whole-command fragment when none are supplied", () => {
    const request = enqueuePluginRequest({
      subject: "shell",
      command: "rm -rf build",
      current_verdict: "ask",
    });
    if (!isShellRequest(request)) throw new Error("expected a shell request");
    expect(request.fragments).toHaveLength(1);
    expect(request.fragments[0]?.display).toBe("rm -rf build");
    expect(request.harness).toBe("allowlister");
  });

  it("lists only pending, undecided requests in creation order", () => {
    const first = enqueuePluginRequest({ command: "npm test" });
    const second = enqueuePluginRequest({ command: "gh pr merge 42" });
    decideRequest(first.id, {
      requestId: first.id,
      verdict: "allow",
      reason: "approved",
    });

    expect(listPendingRequests().map((request) => request.id)).toEqual([second.id]);
  });

  it("keeps requests pending indefinitely (approvals never expire)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-18T00:00:00.000Z"));
    const request = enqueuePluginRequest({ command: "gh pr merge 42" });

    vi.setSystemTime(new Date("2026-06-19T00:00:00.000Z"));
    expect(listPendingRequests().map((entry) => entry.id)).toEqual([request.id]);
  });

  it("stores and retrieves decisions for plugin polling", () => {
    const request = enqueuePluginRequest({ command: "rm -rf build" });
    expect(getDecision(request.id)).toBeNull();

    decideRequest(request.id, {
      requestId: request.id,
      verdict: "deny",
      reason: "too destructive",
    });

    expect(getDecision(request.id)).toEqual({
      requestId: request.id,
      verdict: "deny",
      reason: "too destructive",
    });
  });
});
