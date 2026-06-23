// The inbox state transitions: pure functions that fold a broker event onto the
// current list of pending requests. These are the only places the live inbox
// grows or shrinks over a session, so isolating them keeps App's effect free of
// reducer logic and — because the PWA holds this list for the whole session —
// gives the memory-footprint harness (src/perf/heap.perf.ts) a real target for
// its retention check: that resolving a request actually releases it and the
// inbox cannot grow without bound.

import { normalizeBrokerRequest } from "@/approval-normalize";
import type { ApprovalRequest } from "@/types";

// Replace the inbox with the broker's snapshot of everything still pending — the
// set the daemon re-announces on (re)subscribe.
export function applySnapshot(snapshot: unknown[]): ApprovalRequest[] {
  return snapshot.map(normalizeBrokerRequest);
}

// Append a newly announced request, deduped by id so a re-announce (e.g. after a
// broker restart) never double-renders a card and never grows the list twice.
export function applyAdded(current: ApprovalRequest[], request: unknown): ApprovalRequest[] {
  const normalized = normalizeBrokerRequest(request);
  return current.some((existing) => existing.id === normalized.id)
    ? current
    : [...current, normalized];
}

// Drop a resolved request, releasing everything it retained. The same fold backs
// an optimistic local decision, so a resolved card is freed exactly once.
export function applyResolved(current: ApprovalRequest[], id: string): ApprovalRequest[] {
  return current.filter((request) => request.id !== id);
}
