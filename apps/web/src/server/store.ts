import { normalizePluginRequest, type PluginPayload } from "../approval-normalize";
import type { ApprovalDecision, ApprovalRequest } from "../types";

type State = {
  requests: Map<string, ApprovalRequest>;
  decisions: Map<string, ApprovalDecision>;
};

const globalState = globalThis as typeof globalThis & {
  __allowlisterRemoteState?: State;
};

if (!globalState.__allowlisterRemoteState) {
  globalState.__allowlisterRemoteState = {
    requests: new Map<string, ApprovalRequest>(),
    decisions: new Map<string, ApprovalDecision>(),
  };
}

const state = globalState.__allowlisterRemoteState;

export function enqueuePluginRequest(input: PluginPayload): ApprovalRequest {
  // Same normalization the broker path uses, so HTTP- and broker-sourced
  // requests render identically in the UI.
  const request = normalizePluginRequest(input, crypto.randomUUID());
  state.requests.set(request.id, request);
  return request;
}

export function listPendingRequests() {
  // Approvals wait indefinitely, so the only filter is whether a decision has
  // landed; the Map preserves insertion (creation) order.
  return [...state.requests.values()].filter((request) => !state.decisions.has(request.id));
}

export function decideRequest(id: string, decision: ApprovalDecision) {
  state.decisions.set(id, decision);
}

export function getDecision(id: string) {
  return state.decisions.get(id) ?? null;
}

export function resetStore() {
  state.requests.clear();
  state.decisions.clear();
}
