// Deterministic heap-footprint report for the PWA — the missing memory-side
// layer of the web perf suite, and the web analogue of the Rust binaries'
// allocation reports (`just bench-allocs`, crates/.../benches/*_allocs.rs).
//
// The other web lanes cover time and size: decision.bench.ts times the pure
// decision functions, bundle-size weighs what ships, render-cost counts wasted
// recomputation, and Lighthouse times a cold load. None of them answers the
// memory-efficiency question for a PWA left open all day: how much heap each
// pending request retains while it sits in the inbox, and whether resolving a
// request actually releases it (or the inbox grows without bound).
//
// This harness answers both with a *deterministic* number — a structural walk of
// the retained object graph (object/array/string counts and string length), not
// `process.memoryUsage()` — so a base-vs-PR delta is trustworthy the way bundle
// size is, never subject to GC timing or shared-runner noise. JS gives us no
// allocation hook the way a custom global allocator does in Rust, so we measure
// the next best deterministic thing: the weight of what stays reachable.
//
//   1. Per-request decision-surface footprint — the object graph every inbox
//      card holds (headline, flagged fragments, triggered rules, script lines /
//      tool-call lines). This is the per-card memory cost, charted against a
//      synthetic long script so its growth with command size is visible.
//   2. Inbox retention over a session — fold a realistic broker event stream
//      (snapshot → many `added` → resolve every one) through the real inbox
//      reducers and assert the retained graph returns to the empty baseline. A
//      leak (a resolved request still reachable) shows up as residual weight.
//
// Run via scripts/web-heap.mjs (`just heap`), which executes this file and
// renders the JSON it writes into a markdown table (and a base-vs-head delta in
// CI). Kept out of the default test/coverage run by its `*.perf.ts` name.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  flaggedFragments,
  requestHeadline,
  scriptLines,
  toolCallLines,
  toolParamSummary,
  triggeredRules,
} from "@/approval";
import { demoRequests } from "@/fixtures";
import { applyAdded, applyResolved, applySnapshot } from "@/inbox";
import { brokerRequestPayloads } from "@/test/broker-fixtures";
import {
  type AllowlisterFragment,
  type ApprovalRequest,
  isToolRequest,
  type ShellApprovalRequest,
} from "@/types";

// A deterministic walk of the object graph reachable from `root`: every distinct
// object/array is counted once (a WeakSet guards shared refs and cycles), and
// every string occurrence contributes its character length. Numbers/booleans are
// inlined by the engine, so they carry no separate heap node and are not counted.
// Object *keys* are shape (shared via hidden classes), so we weigh values, not
// keys — the payload an inbox card actually retains.
interface Footprint {
  objects: number;
  arrays: number;
  strings: number;
  stringChars: number;
}

// Tally one value into `fp` and return its children to keep traversing (or null
// for a leaf / an already-seen node). Strings are leaves that carry weight;
// numbers/booleans are inlined leaves; objects/arrays are nodes counted once.
function visit(value: unknown, fp: Footprint, seen: WeakSet<object>): unknown[] | null {
  if (typeof value === "string") {
    fp.strings += 1;
    fp.stringChars += value.length;
    return null;
  }
  if (value === null || typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    fp.arrays += 1;
    return value;
  }
  fp.objects += 1;
  return Object.values(value);
}

function footprint(root: unknown): Footprint {
  const fp: Footprint = { objects: 0, arrays: 0, strings: 0, stringChars: 0 };
  const seen = new WeakSet<object>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const children = visit(stack.pop(), fp, seen);
    if (children) for (const child of children) stack.push(child);
  }
  return fp;
}

const emptyFootprint = (): Footprint => ({ objects: 0, arrays: 0, strings: 0, stringChars: 0 });
const addFootprint = (a: Footprint, b: Footprint): Footprint => ({
  objects: a.objects + b.objects,
  arrays: a.arrays + b.arrays,
  strings: a.strings + b.strings,
  stringChars: a.stringChars + b.stringChars,
});

// The retained decision surface for one card: exactly the pure-function outputs a
// rendered card holds on to (the same surface decision.bench.ts times and
// render-cost counts). Tool and shell cards retain different shapes.
function decisionSurface(request: ApprovalRequest): unknown {
  if (isToolRequest(request)) {
    return {
      headline: requestHeadline(request),
      params: toolParamSummary(request),
      lines: toolCallLines(request),
    };
  }
  return {
    headline: requestHeadline(request),
    flagged: flaggedFragments(request),
    rules: triggeredRules(request),
    script: scriptLines(request),
  };
}

// A synthetic release-style script of N fragments, all-but-some allowed — the
// same worst case decision.bench.ts charts, here measured for retained weight
// rather than time. Mirrors longScript in decision.bench.ts.
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
    id: "heap-long",
    protocolVersion: 3,
    subject: "shell",
    harness: "codex",
    sessionId: "9f3c1a2b7e4d",
    cwd: "/workspace/acme-api",
    command: frags.map((f) => f.display).join("\n"),
    currentVerdict: "ask",
    currentReason: "synthetic",
    fragments: frags,
  };
}

test("PWA heap footprint", () => {
  // 1. Per-request decision-surface footprint, by fixture id.
  const perRequest = demoRequests.map((request) => ({
    id: request.id,
    footprint: footprint(decisionSurface(request)),
  }));

  // 1b. How the per-card footprint scales with script length.
  const scaling = [4, 32, 256].map((len) => ({
    scriptLen: len,
    footprint: footprint(decisionSurface(longScript(len))),
  }));

  // 2. Inbox retention over a session. Start from the broker snapshot, then
  //    announce many more requests (cloned with unique ids), measure what the
  //    full inbox retains, then resolve every one and confirm the inbox returns
  //    to the empty baseline — a residual graph would mean a resolved request is
  //    still reachable (a leak).
  const ADDED = 200;
  let inbox = applySnapshot(brokerRequestPayloads);
  const snapshotCount = inbox.length;
  for (let i = 0; i < ADDED; i += 1) {
    const base = brokerRequestPayloads[i % brokerRequestPayloads.length] as Record<string, unknown>;
    inbox = applyAdded(inbox, { ...base, id: `${String(base.id)}-${i}` });
  }
  const heldCount = inbox.length;
  const heldFootprint = footprint(inbox);

  // Resolve every pending request, one event at a time.
  for (const request of [...inbox]) {
    inbox = applyResolved(inbox, request.id);
  }
  const drainedCount = inbox.length;
  const drainedFootprint = footprint(inbox);
  const baselineFootprint = footprint(applySnapshot([]));

  const totalPerRequest = perRequest.reduce(
    (sum, entry) => addFootprint(sum, entry.footprint),
    emptyFootprint(),
  );

  const report = {
    perRequest,
    scaling,
    retention: {
      snapshotCount,
      addedCount: ADDED,
      heldCount,
      heldFootprint,
      // Per held card, derived — the steady-state cost of one pending request.
      perHeld: {
        objects: +(heldFootprint.objects / heldCount).toFixed(2),
        stringChars: Math.round(heldFootprint.stringChars / heldCount),
      },
      drainedCount,
      drainedFootprint,
      baselineFootprint,
      // The whole point: after resolving everything, nothing is retained.
      releasedClean:
        drainedCount === 0 && drainedFootprint.stringChars === baselineFootprint.stringChars,
    },
    totalPerRequest,
  };

  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
  const out = process.env.HEAP_OUT ?? join(repoRoot, "target/web-perf");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "heap.json"), `${JSON.stringify(report, null, 2)}\n`);

  // Sanity, not a gate (perf is informational): the surface must retain
  // something, and resolving the whole inbox must release all of it.
  expect(totalPerRequest.objects).toBeGreaterThan(0);
  expect(report.retention.heldCount).toBe(snapshotCount + ADDED);
  expect(report.retention.releasedClean).toBe(true);
});
