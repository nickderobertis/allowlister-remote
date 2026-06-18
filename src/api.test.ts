import { beforeEach, describe, expect, it, vi } from "vitest";
import { DemoApprovalApi, HttpApprovalApi } from "./api";

describe("approval APIs", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
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

  it("removes demo requests after a decision", async () => {
    const api = new DemoApprovalApi();
    const [request] = await api.listRequests();

    await api.decide({
      requestId: request.id,
      verdict: "deny",
      reason: "nope",
    });

    await expect(api.listRequests()).resolves.toEqual([]);
    expect(api.decisions).toEqual([
      { requestId: request.id, verdict: "deny", reason: "nope" },
    ]);
  });

  it("surfaces bridge failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503 }),
    );
    const api = new HttpApprovalApi();

    await expect(api.listRequests()).rejects.toThrow(
      "request list failed: 503",
    );
  });
});
