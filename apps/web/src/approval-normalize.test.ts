import { describe, expect, it } from "vitest";
import { normalizeBrokerRequest, normalizePluginRequest } from "./approval-normalize";
import { isShellRequest, isToolRequest } from "./types";

describe("normalizePluginRequest", () => {
  it("normalizes a shell payload and preserves verbatim fragments", () => {
    const request = normalizePluginRequest(
      {
        protocol_version: 3,
        subject: "shell",
        command: "gh pr merge 42",
        cwd: "/repo",
        harness: "claude-code",
        session_id: "9f3c1a2b7e4d",
        current_verdict: "defer",
        current_reason: "needs review",
        fragments: [
          { display: "gh pr merge 42", argv: ["gh", "pr"], role: "standalone", verdict: "ask" },
        ],
      },
      "id-1",
    );
    expect(request.id).toBe("id-1");
    expect(request.currentVerdict).toBe("defer");
    // The harness session id (protocol v3) rides through verbatim.
    expect(request.sessionId).toBe("9f3c1a2b7e4d");
    if (!isShellRequest(request)) throw new Error("expected shell");
    expect(request.command).toBe("gh pr merge 42");
    expect(request.fragments[0]?.verdict).toBe("ask");
  });

  it("treats a missing or empty session id as no session", () => {
    // allowlister omits `session_id` entirely when the harness has none.
    expect(
      normalizePluginRequest({ subject: "shell", command: "ls" }, "id-a").sessionId,
    ).toBeNull();
    // A blank string is not a real id either.
    expect(
      normalizePluginRequest({ subject: "shell", command: "ls", session_id: "" }, "id-b").sessionId,
    ).toBeNull();
  });

  it("falls back to a whole-command fragment when none are provided", () => {
    const request = normalizePluginRequest({ subject: "shell", command: "rm -rf build" }, "id-2");
    if (!isShellRequest(request)) throw new Error("expected shell");
    expect(request.fragments).toHaveLength(1);
    expect(request.fragments[0]?.argv).toEqual(["rm", "-rf", "build"]);
  });

  it("normalizes a tool payload", () => {
    const request = normalizePluginRequest(
      {
        subject: "tool",
        tool: { name: "mcp__github__create_issue", capability: "mcp", params: { repo: "app" } },
      },
      "id-3",
    );
    if (!isToolRequest(request)) throw new Error("expected tool");
    expect(request.tool.name).toBe("mcp__github__create_issue");
    expect(request.tool.capability).toBe("mcp");
  });

  it("defaults unknown verdicts and missing fields", () => {
    const request = normalizePluginRequest({ subject: "shell", current_verdict: "maybe" }, "id-4");
    expect(request.currentVerdict).toBe("defer");
    expect(request.harness).toBe("allowlister");
    expect(request.protocolVersion).toBe(3);
    if (!isShellRequest(request)) throw new Error("expected shell");
    expect(request.command).toBe("");
    expect(request.fragments).toEqual([]);
  });

  it("tolerates garbled fragment entries", () => {
    const request = normalizePluginRequest(
      { subject: "shell", command: "x", fragments: [42, { display: "y" }] },
      "id-5",
    );
    if (!isShellRequest(request)) throw new Error("expected shell");
    expect(request.fragments).toHaveLength(2);
    expect(request.fragments[1]?.display).toBe("y");
  });
});

describe("normalizeBrokerRequest", () => {
  it("uses the daemon-assigned id from the broker object", () => {
    const request = normalizeBrokerRequest({
      id: "broker-1",
      subject: "shell",
      command: "ls",
    });
    expect(request.id).toBe("broker-1");
  });

  it("generates an id when the broker object lacks one", () => {
    const request = normalizeBrokerRequest({ subject: "shell", command: "ls" });
    expect(request.id).toMatch(/[0-9a-f-]+/);
  });

  it("handles a non-object input defensively", () => {
    const request = normalizeBrokerRequest(null);
    expect(request.id).toMatch(/[0-9a-f-]+/);
    expect(isShellRequest(request)).toBe(true);
  });
});
