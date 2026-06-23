import { describe, expect, it } from "vitest";
import { applyAdded, applyResolved, applySnapshot } from "@/inbox";
import { brokerRequestPayloads } from "@/test/broker-fixtures";

describe("applySnapshot", () => {
  it("normalizes the broker's pending set", () => {
    const inbox = applySnapshot(brokerRequestPayloads);
    expect(inbox).toHaveLength(brokerRequestPayloads.length);
    expect(inbox.map((request) => request.id)).toEqual([
      "demo-oneoff",
      "demo-release-script",
      "demo-tool-mcp",
      "demo-tool-write",
    ]);
  });

  it("is empty for an empty snapshot", () => {
    expect(applySnapshot([])).toEqual([]);
  });
});

describe("applyAdded", () => {
  it("appends a normalized request", () => {
    const inbox = applyAdded([], brokerRequestPayloads[0]);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.id).toBe("demo-oneoff");
  });

  it("dedupes a re-announced id without growing the list", () => {
    const first = applyAdded([], brokerRequestPayloads[0]);
    const second = applyAdded(first, brokerRequestPayloads[0]);
    expect(second).toBe(first);
    expect(second).toHaveLength(1);
  });
});

describe("applyResolved", () => {
  it("drops the resolved request and keeps the rest", () => {
    const inbox = applySnapshot(brokerRequestPayloads);
    const resolved = applyResolved(inbox, "demo-release-script");
    expect(resolved.map((request) => request.id)).toEqual([
      "demo-oneoff",
      "demo-tool-mcp",
      "demo-tool-write",
    ]);
  });

  it("is a no-op for an unknown id", () => {
    const inbox = applySnapshot(brokerRequestPayloads);
    expect(applyResolved(inbox, "nope")).toHaveLength(inbox.length);
  });

  it("drains to empty as every request resolves", () => {
    let inbox = applySnapshot(brokerRequestPayloads);
    for (const request of [...inbox]) {
      inbox = applyResolved(inbox, request.id);
    }
    expect(inbox).toEqual([]);
  });
});
