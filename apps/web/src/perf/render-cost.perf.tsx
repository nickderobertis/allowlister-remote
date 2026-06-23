// Deterministic render-cost harness for the PWA — the missing render-side
// analogue of the plugin's cachegrind instruction counts (scripts/bench-*.sh).
//
// The Vitest microbenches (decision.bench.ts) time the pure decision functions
// in isolation, the bundle-size report weighs what ships, and Lighthouse times a
// cold load — but none of them observe the thing React Compiler actually
// changes: how much work the live component tree redoes when a piece of state
// changes that should not touch most of it. This harness does, and it does so
// with a *deterministic* number (call counts, not wall-clock), so a
// baseline-vs-compiler delta is trustworthy the way bundle size is.
//
// It renders the real <App> with an inbox of N requests delivered through a
// stubbed broker, then drives two representative interactions and counts how
// many times the decision surface every card runs — requestHeadline,
// flaggedFragments, scriptLines, toolCallLines, triggeredRules — is recomputed
// during each. Those calls are the per-render cost the screen pays; eliminating
// the wasted ones is the compiler's whole job here.
//
//   1. Toggle the shortcuts panel (`?`). This is state that does not belong to
//      the inbox at all. Without memoization, App re-renders, hands the inbox a
//      freshly-built `decide` handler, and every card recomputes. The compiler
//      stabilizes the handler so the inbox subtree bails out entirely.
//   2. Arrow-key navigation (`ArrowDown`). focusedIndex changes, so the inbox
//      list re-runs either way; but the compiler caches each card's decision
//      computations on its (unchanged) request, so they are not recomputed.
//
// Run via scripts/web-render-cost.mjs (`just render-cost`), which executes this
// file twice — REACT_COMPILER unset, then =1 — and diffs the two reports.
// REACT_COMPILER only labels the output here; the config wires the Babel pass.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Profiler, type ProfilerOnRenderCallback } from "react";
import { expect, test, vi } from "vitest";
import App from "@/App";
import * as approval from "@/approval";
import { demoRequests } from "@/fixtures";
import type { ApprovalRequest } from "@/types";

// The broker is App's only data source; stub the bridge so connectBroker hands
// back the snapshot we choose and a no-op decide/close. We capture the handlers
// so the test pushes the snapshot itself (after mount), sidestepping vi.mock's
// hoisting rules around module-scope fixtures.
let brokerHandlers: {
  onSnapshot?: (requests: unknown[]) => void;
  onStatus?: (status: string) => void;
} = {};
vi.mock("@/pwa/broker-bridge", () => ({
  connectBroker: (_url: string, handlers: typeof brokerHandlers) => {
    brokerHandlers = handlers;
    return { decide: vi.fn(), close: vi.fn() };
  },
}));
// Snapshot items arrive in broker wire form and are normalized on the way in;
// our fixtures are already ApprovalRequests, so normalization is the identity.
vi.mock("@/approval-normalize", () => ({ normalizeBrokerRequest: (r: unknown) => r }));

// N cloned demo requests with unique ids — a realistic-to-large inbox so the
// per-card cost the compiler removes is visible and the delta is stable.
const INBOX_SIZE = 24;
const fixtures: ApprovalRequest[] = Array.from({ length: INBOX_SIZE }, (_, i) => {
  const base = demoRequests[i % demoRequests.length] as ApprovalRequest;
  return { ...base, id: `${base.id}-${i}` };
});

// The decision surface every card render runs. These are exactly the pure
// functions decision.bench.ts times in isolation; here we count how often the
// live tree calls them, which is what the compiler is meant to shrink.
const DECISION_FNS = [
  "requestHeadline",
  "flaggedFragments",
  "scriptLines",
  "toolCallLines",
  "triggeredRules",
] as const;

const compilerEnabled = process.env.REACT_COMPILER === "1";

test(`render cost over ${INBOX_SIZE} cards (compiler=${compilerEnabled})`, async () => {
  const spies = DECISION_FNS.map((name) => vi.spyOn(approval, name));
  const decisionCalls = () => spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
  const clear = () => {
    for (const spy of spies) spy.mockClear();
  };

  // App requires a service worker and a configured broker base to reach the
  // inbox; jsdom has neither, so provide both.
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { controller: null, addEventListener() {}, removeEventListener() {} },
  });
  window.localStorage.setItem("allowlister-remote-broker-url", "ws://broker.test");

  // One Profiler commit count + actualDuration per interaction. Commit count is
  // deterministic; actualDuration is wall-clock and noisy — reported as context.
  let commits = 0;
  let durationMs = 0;
  const onRender: ProfilerOnRenderCallback = (_id, _phase, actual) => {
    commits += 1;
    durationMs += actual;
  };
  const sample = async (interact: () => void) => {
    clear();
    commits = 0;
    durationMs = 0;
    await act(async () => {
      interact();
    });
    return { decisionCalls: decisionCalls(), commits, durationMs };
  };

  render(
    <Profiler id="app" onRender={onRender}>
      <App />
    </Profiler>,
  );
  // Deliver the inbox the way the broker would, then wait for the cards.
  await act(async () => {
    brokerHandlers.onStatus?.("open");
    brokerHandlers.onSnapshot?.(fixtures);
  });
  const cards = await screen.findAllByRole("listitem");
  expect(cards).toHaveLength(INBOX_SIZE);

  const mountDecisionCalls = decisionCalls();

  // 1. Unrelated state: open the shortcuts panel. The inbox stays mounted
  //    underneath; nothing about the requests changed.
  const toggleShortcuts = await sample(() => fireEvent.keyDown(document.body, { key: "?" }));
  // Restore the inbox-active state (arrow keys pause while the panel is open).
  await act(async () => {
    fireEvent.keyDown(document.body, { key: "?" });
  });

  // 2. Inbox navigation: move the keyboard cursor one card down.
  const arrowNav = await sample(() => fireEvent.keyDown(document.body, { key: "ArrowDown" }));

  const report = {
    compiler: compilerEnabled,
    inboxSize: INBOX_SIZE,
    mountDecisionCalls,
    interactions: { toggleShortcuts, arrowNav },
  };

  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
  const out = process.env.RENDER_COST_OUT ?? join(repoRoot, "target/web-perf");
  mkdirSync(out, { recursive: true });
  const mode = compilerEnabled ? "compiler" : "baseline";
  writeFileSync(join(out, `render-cost.${mode}.json`), `${JSON.stringify(report, null, 2)}\n`);

  // Sanity, not a gate: the first paint must actually exercise the decision
  // surface, or the harness is measuring nothing.
  expect(mountDecisionCalls).toBeGreaterThan(0);
});
