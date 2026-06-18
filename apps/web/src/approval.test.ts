import { describe, expect, it } from "vitest";
import { demoRequests } from "./fixtures";
import { importantCommands, riskSignals, secondsRemaining } from "./approval";

const request = demoRequests[0];

describe("approval helpers", () => {
  it("promotes ask/deny fragments instead of the full script", () => {
    expect(importantCommands(request)).toEqual([
      "gh pr merge 42 --squash --delete-branch",
    ]);
  });

  it("combines allowlister and inferred risk signals", () => {
    expect(riskSignals(request)).toEqual([
      "GitHub write",
      "branch deletion",
      "merge action",
      "deletion",
    ]);
  });

  it("never returns a negative countdown", () => {
    expect(
      secondsRemaining(request, Date.parse(request.expiresAt) + 1_000),
    ).toBe(0);
  });
});

it("falls back to the first fragments or raw command", () => {
  const allowed = {
    ...request,
    fragments: request.fragments.slice(0, 2),
    riskSignals: [],
  };
  expect(importantCommands(allowed)).toEqual(["git diff --stat", "npm test"]);
  expect(importantCommands({ ...allowed, fragments: [] })).toEqual([
    request.command,
  ]);
});

it("returns an empty safe signal list", () => {
  expect(
    riskSignals({
      ...request,
      command: "npm test",
      cwd: "/workspace/app",
      riskSignals: [],
    }),
  ).toEqual([]);
});
