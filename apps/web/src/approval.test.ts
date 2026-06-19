import { describe, expect, it } from "vitest";
import {
  flaggedFragments,
  remainingDisplay,
  requestHeadline,
  secondsRemaining,
  toolParamSummary,
  triggeredRules,
} from "./approval";
import { demoRequests } from "./fixtures";
import {
  isShellRequest,
  isToolRequest,
  type ShellApprovalRequest,
  type ToolApprovalRequest,
} from "./types";

function shellFixture(id: string): ShellApprovalRequest {
  const request = demoRequests.find((entry) => entry.id === id);
  if (!request || !isShellRequest(request)) {
    throw new Error(`expected shell fixture ${id}`);
  }
  return request;
}

function toolFixture(id: string): ToolApprovalRequest {
  const request = demoRequests.find((entry) => entry.id === id);
  if (!request || !isToolRequest(request)) {
    throw new Error(`expected tool fixture ${id}`);
  }
  return request;
}

const oneOff = shellFixture("demo-oneoff");
const script = shellFixture("demo-release-script");
const mcpTool = toolFixture("demo-tool-mcp");

describe("shell approval helpers", () => {
  it("flags only the fragments that did not statically allow", () => {
    expect(flaggedFragments(script).map((fragment) => fragment.display)).toEqual([
      "npm publish --access public",
      "git push origin main --tags",
    ]);
  });

  it("falls back to all fragments when nothing is flagged", () => {
    const allAllow: ShellApprovalRequest = {
      ...script,
      fragments: script.fragments.map((fragment) => ({ ...fragment, verdict: "allow" })),
    };
    expect(flaggedFragments(allAllow)).toHaveLength(script.fragments.length);
  });

  it("surfaces the real rule names that fired, deduplicated", () => {
    expect(triggeredRules(script)).toEqual([
      "ask before publishing a package",
      "ask before pushing to a remote",
    ]);
    // A deferred one-off matched no rule, so there are none.
    expect(triggeredRules(oneOff)).toEqual([]);
  });

  it("headlines a shell request with its first flagged fragment", () => {
    expect(requestHeadline(script)).toBe("npm publish --access public");
    expect(requestHeadline(oneOff)).toBe("gh pr merge 42 --squash --delete-branch");
  });
});

describe("tool approval helpers", () => {
  it("headlines a tool request with the tool name", () => {
    expect(requestHeadline(mcpTool)).toBe("mcp__github__create_issue");
  });

  it("summarizes canonical tool parameters", () => {
    expect(toolParamSummary(mcpTool)).toBe("mcp_server = github · mcp_tool = create_issue");
    expect(toolParamSummary(toolFixture("demo-tool-write"))).toBe(
      "path = /repo/.github/workflows/deploy.yml",
    );
  });
});

describe("countdown helpers", () => {
  it("never returns a negative countdown", () => {
    expect(secondsRemaining(script, Date.parse(script.expiresAt ?? "") + 1_000)).toBe(0);
  });

  it("treats a request without an expiry as waiting indefinitely", () => {
    const indefinite = { ...script, expiresAt: null };
    expect(secondsRemaining(indefinite)).toBeNull();
    expect(remainingDisplay(indefinite)).toEqual({
      value: "∞",
      unit: "waiting",
      label: "waiting for a decision",
      compact: "∞",
    });
  });

  it("formats a live countdown for requests that expire", () => {
    expect(remainingDisplay(script, Date.parse(script.expiresAt ?? "") - 5_000)).toEqual({
      value: "5",
      unit: "sec",
      label: "5 seconds remaining",
      compact: "5s",
    });
  });
});
