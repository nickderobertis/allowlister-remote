import { describe, expect, it } from "vitest";
import {
  flaggedFragments,
  requestHeadline,
  scriptLines,
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
      "kubectl --context $region apply -f deploy/manifest.yaml",
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
      "ask before applying kubernetes manifests",
      "ask before pushing to a remote",
    ]);
    // A deferred one-off matched no rule, so there are none.
    expect(triggeredRules(oneOff)).toEqual([]);
  });

  it("headlines a shell request with its first flagged fragment", () => {
    expect(requestHeadline(script)).toBe("kubectl --context $region apply -f deploy/manifest.yaml");
    expect(requestHeadline(oneOff)).toBe("gh pr merge 42 --squash --delete-branch");
  });

  it("reconstructs the script line by line, pairing each line with its fragment", () => {
    // Every source line is present in order — including the `for … do` header and
    // its `done`, which the flat fragment list drops — with its verbatim
    // indentation. A fragment-bearing line carries that fragment; the bare `done`
    // carries none. The `$(cat …)` substitution maps onto the `for` header line.
    const lines = scriptLines(script);
    expect(lines.map((line) => line.text)).toEqual([
      "set -euo pipefail",
      "npm run build",
      "for region in $(cat deploy/regions.txt); do",
      "  curl -fsS https://api.acme.dev/$region/healthz",
      "  kubectl --context $region apply -f deploy/manifest.yaml",
      "done",
      "git push origin main --tags",
    ]);
    expect(lines.map((line) => line.fragment?.display ?? null)).toEqual([
      "set -euo pipefail",
      "npm run build",
      "cat deploy/regions.txt",
      "curl -fsS https://api.acme.dev/$region/healthz",
      "kubectl --context $region apply -f deploy/manifest.yaml",
      null,
      "git push origin main --tags",
    ]);
  });

  it("reconstructs a single-line command as one fragment-bearing line", () => {
    const lines = scriptLines(oneOff);
    expect(lines.map((line) => line.text)).toEqual(["gh pr merge 42 --squash --delete-branch"]);
    expect(lines[0]?.fragment?.display).toBe("gh pr merge 42 --squash --delete-branch");
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
