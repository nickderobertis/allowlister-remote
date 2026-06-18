import type { ApprovalDecision, ApprovalRequest } from "../types";

type PluginPayload = {
  command?: unknown;
  cwd?: unknown;
  harness?: unknown;
  current_verdict?: unknown;
  current_reason?: unknown;
};

type State = {
  requests: Map<string, ApprovalRequest>;
  decisions: Map<string, ApprovalDecision>;
};

const globalState = globalThis as typeof globalThis & {
  __allowlisterRemoteState?: State;
};

const state =
  globalState.__allowlisterRemoteState ??
  (globalState.__allowlisterRemoteState = {
    requests: new Map<string, ApprovalRequest>(),
    decisions: new Map<string, ApprovalDecision>(),
  });

function commandFragments(command: string) {
  return command
    .split(/\s*(?:&&|\|\||;|\|)\s*/u)
    .map((piece) => piece.trim())
    .filter(Boolean)
    .map((display) => ({
      argv: display.split(/\s+/u),
      display,
      role: "standalone",
      verdict: "ask" as const,
    }));
}

function riskSignals(command: string, cwd: string) {
  const haystack = `${command} ${cwd}`.toLowerCase();
  return [
    ["rm", "destructive file operation"],
    ["sudo", "privileged command"],
    ["curl", "network fetch"],
    ["wget", "network fetch"],
    ["push", "remote write"],
    ["merge", "merge action"],
    ["delete", "deletion"],
    ["token", "secret-looking argument"],
    [".env", "secret-looking path"],
  ]
    .filter(([term]) => haystack.includes(term))
    .map(([, label]) => label);
}

export function enqueuePluginRequest(
  input: PluginPayload,
  timeoutMs: number,
): ApprovalRequest {
  const now = Date.now();
  const command = String(input.command ?? "");
  const cwd = String(input.cwd ?? "");
  const request: ApprovalRequest = {
    id: crypto.randomUUID(),
    subject: "shell",
    harness: String(input.harness ?? "allowlister"),
    cwd,
    command,
    currentVerdict:
      input.current_verdict === "ask" || input.current_verdict === "defer"
        ? input.current_verdict
        : "defer",
    currentReason: String(input.current_reason ?? ""),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + timeoutMs).toISOString(),
    fragments: commandFragments(command),
    riskSignals: riskSignals(command, cwd),
  };
  state.requests.set(request.id, request);
  return request;
}

export function listPendingRequests() {
  const now = Date.now();
  return [...state.requests.values()]
    .filter(
      (request) =>
        !state.decisions.has(request.id) && Date.parse(request.expiresAt) > now,
    )
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
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
