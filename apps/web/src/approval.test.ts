import { describe, expect, it } from "vitest";
import {
  flaggedFragments,
  requestHeadline,
  scriptContextLines,
  toolCallLines,
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

  it("returns the script lines around the flagged commands, in source order", () => {
    // The flagged `npm publish` / `git push` lines are dropped (they show as
    // flagged fragments); the surrounding context keeps its source indentation.
    expect(scriptContextLines(script)).toEqual([
      "set -euo pipefail",
      "npm run build",
      "for attempt in $(seq 1 30); do",
      "  curl -fsS https://api.acme.dev/healthz",
      "  sleep 10",
      "done",
    ]);
  });

  it("has no surrounding context when the whole command is a single flagged line", () => {
    expect(scriptContextLines(oneOff)).toEqual([]);
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

  it("lists the verbatim tool-call arguments as key = value lines", () => {
    expect(toolCallLines(mcpTool)).toEqual([
      "owner = acme",
      "repo = app",
      "title = Production is down",
      "body = sev1",
    ]);
    expect(toolCallLines(toolFixture("demo-tool-write"))).toEqual([
      "path = /repo/.github/workflows/deploy.yml",
    ]);
  });

  it("JSON-encodes non-string argument values", () => {
    const withObject: ToolApprovalRequest = {
      ...mcpTool,
      tool: { ...mcpTool.tool, raw: { count: 3, labels: ["bug", "p1"] } },
    };
    expect(toolCallLines(withObject)).toEqual(["count = 3", 'labels = ["bug","p1"]']);
  });
});
