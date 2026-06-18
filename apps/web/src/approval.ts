import type { ApprovalRequest } from "./types";

const riskyTerms = new Map([
  ["rm", "destructive file operation"],
  ["sudo", "privileged command"],
  ["curl", "network fetch"],
  ["wget", "network fetch"],
  ["push", "remote write"],
  ["merge", "merge action"],
  ["delete", "deletion"],
  ["token", "secret-looking argument"],
  [".env", "secret-looking path"],
]);

export function importantCommands(request: ApprovalRequest): string[] {
  const actionable = request.fragments
    .filter((fragment) => fragment.verdict === "ask" || fragment.verdict === "deny")
    .map((fragment) => fragment.display);

  if (actionable.length > 0) {
    return actionable;
  }

  return request.fragments.length > 0
    ? request.fragments.slice(0, 4).map((fragment) => fragment.display)
    : [request.command];
}

export function riskSignals(request: ApprovalRequest): string[] {
  const signals = new Set(request.riskSignals);
  const haystack = `${request.command} ${request.cwd}`.toLowerCase();

  for (const [term, label] of riskyTerms) {
    if (haystack.includes(term)) {
      signals.add(label);
    }
  }

  return [...signals];
}

export function secondsRemaining(request: ApprovalRequest, now = Date.now()): number {
  return Math.max(0, Math.ceil((Date.parse(request.expiresAt) - now) / 1000));
}
