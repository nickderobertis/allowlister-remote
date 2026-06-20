// Vitest micro-benchmarks for the PWA's pure, render-free decision surface.
//
// The web analogue of the plugin's Criterion engine benches
// (crates/allowlister-remote-plugin/benches/engine.rs): they isolate the pure
// functions every render runs to turn an allowlister payload into what the
// operator sees — filtering the flagged fragments, collecting triggered rules,
// the request headline, and the tool-param summary — without React, the DOM, or
// the network in any timed loop. React rendering and
// the full browser load are covered by the Lighthouse layer and the e2e suite,
// not here.
//
// `*.bench.ts` is excluded from the Vitest test run (which targets `*.test.ts`)
// and from coverage; `vitest bench` discovers it. Fixtures are the real demo
// payloads plus a synthetic long-script case that charts how the fragment scan
// scales with command size — the web counterpart of `triage_scaling`.

import { bench, describe } from "vitest";
import {
  flaggedFragments,
  requestHeadline,
  toolParamSummary,
  triggeredRules,
} from "../approval";
import { demoRequests } from "../fixtures";
import type { AllowlisterFragment, ShellApprovalRequest, ToolApprovalRequest } from "../types";
import { isShellRequest, isToolRequest } from "../types";

const shellRequests = demoRequests.filter(isShellRequest);
const toolRequests = demoRequests.filter(isToolRequest);

// A synthetic release-style script of N fragments, all-but-two allowed — the
// worst case for the flagged-fragment scan and the rule de-duplication.
function longScript(fragments: number): ShellApprovalRequest {
  const frags: AllowlisterFragment[] = Array.from({ length: fragments }, (_, i) => ({
    display: `step-${i} --flag value-${i}`,
    argv: ["step", `${i}`, "--flag", `value-${i}`],
    role: "standalone",
    verdict: i % 16 === 0 ? "ask" : "allow",
    rule: i % 16 === 0 ? `ask rule ${i % 4}` : `allow rule ${i % 8}`,
    reason: "synthetic",
  }));
  return {
    id: "bench-long",
    protocolVersion: 2,
    subject: "shell",
    harness: "codex",
    cwd: "/workspace/acme-api",
    command: frags.map((f) => f.display).join("\n"),
    currentVerdict: "ask",
    currentReason: "synthetic",
    fragments: frags,
  };
}

describe("flaggedFragments", () => {
  for (const request of shellRequests) {
    bench(request.id, () => {
      flaggedFragments(request);
    });
  }
});

describe("triggeredRules", () => {
  for (const request of shellRequests) {
    bench(request.id, () => {
      triggeredRules(request);
    });
  }
});

describe("requestHeadline", () => {
  for (const request of demoRequests) {
    bench(request.id, () => {
      requestHeadline(request);
    });
  }
});

describe("toolParamSummary", () => {
  for (const request of toolRequests as ToolApprovalRequest[]) {
    bench(request.id, () => {
      toolParamSummary(request);
    });
  }
});

// How the flagged-fragment scan + rule de-duplication scale with script length.
describe("flaggedFragments/script_len", () => {
  for (const len of [4, 32, 256]) {
    const request = longScript(len);
    bench(String(len), () => {
      flaggedFragments(request);
      triggeredRules(request);
    });
  }
});
