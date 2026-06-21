import { beforeEach, describe, expect, it } from "vitest";
import { resetStore } from "../../../src/server/store";
import { POST as decide } from "../approval-requests/[id]/decision/route";
import { GET as listRequests } from "../approval-requests/route";
import { GET as pollDecision } from "../plugin/requests/[id]/decision/route";
import { POST as enqueue } from "../plugin/requests/route";

function jsonRequest(body: unknown) {
  return new Request("http://localhost/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Next approval API routes", () => {
  beforeEach(() => resetStore());

  it("accepts a Rust plugin request, exposes it to the app, and returns the browser decision", async () => {
    const created = await enqueue(
      jsonRequest({
        command: "gh pr merge 42 --delete-branch",
        cwd: "/workspace/repo",
        harness: "claude-code",
        session_id: "9f3c1a2b7e4d",
        current_verdict: "defer",
        current_reason: "requires human review",
      }),
    );
    expect(created.status).toBe(200);
    const { id } = (await created.json()) as { id: string };

    const listed = await listRequests();
    const requests = await listed.json();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      id,
      command: "gh pr merge 42 --delete-branch",
      currentVerdict: "defer",
      // The harness session id (protocol v3) survives the HTTP round-trip.
      sessionId: "9f3c1a2b7e4d",
    });

    const pending = await pollDecision(new Request("http://localhost"), {
      params: Promise.resolve({ id }),
    });
    expect(pending.status).toBe(202);
    expect(await pending.json()).toEqual({ status: "pending" });

    const decided = await decide(jsonRequest({ verdict: "allow", reason: "approved remotely" }), {
      params: Promise.resolve({ id }),
    });
    expect(decided.status).toBe(200);

    const decision = await pollDecision(new Request("http://localhost"), {
      params: Promise.resolve({ id }),
    });
    expect(decision.status).toBe(200);
    expect(await decision.json()).toEqual({
      requestId: id,
      verdict: "allow",
      reason: "approved remotely",
    });
  });

  it("rejects invalid browser decision verdicts", async () => {
    const response = await decide(jsonRequest({ verdict: "maybe" }), {
      params: Promise.resolve({ id: "req_123" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "verdict must be allow or deny",
    });
  });
});
