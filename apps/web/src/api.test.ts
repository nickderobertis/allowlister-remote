import { beforeEach, describe, expect, it, vi } from "vitest";
import { DemoApprovalApi, HttpApprovalApi } from "./api";

describe("approval APIs", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("loads requests from the bridge contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => [{ id: "req" }] }),
    );
    const api = new HttpApprovalApi("https://bridge.example");

    await expect(api.listRequests()).resolves.toEqual([{ id: "req" }]);
  });

  it("posts decisions to the bridge contract", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const api = new HttpApprovalApi("https://bridge.example");

    await api.decide({
      requestId: "abc",
      verdict: "allow",
      reason: "looks right",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://bridge.example/api/approval-requests/abc/decision",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("removes only the decided demo request and keeps the rest pending", async () => {
    const api = new DemoApprovalApi();
    const initial = await api.listRequests();
    const [request] = initial;
    if (!request) {
      throw new Error("expected demo request fixture");
    }

    await api.decide({
      requestId: request.id,
      verdict: "deny",
      reason: "nope",
    });

    const remaining = await api.listRequests();
    expect(remaining).toHaveLength(initial.length - 1);
    expect(remaining.some((entry) => entry.id === request.id)).toBe(false);
    expect(api.decisions).toEqual([{ requestId: request.id, verdict: "deny", reason: "nope" }]);
  });

  it("surfaces bridge failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    const api = new HttpApprovalApi();

    await expect(api.listRequests()).rejects.toThrow("request list failed: 503");
    await expect(api.decide({ requestId: "abc", verdict: "deny", reason: "bad" })).rejects.toThrow(
      "decision failed: 503",
    );
  });
});
