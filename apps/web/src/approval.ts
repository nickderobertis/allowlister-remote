import {
  type AllowlisterFragment,
  type ApprovalRequest,
  isToolRequest,
  type ShellApprovalRequest,
  type ToolApprovalRequest,
} from "./types";

// The fragments that actually tripped the gate: allowlister already decided the
// rest are `allow`, so anything else (ask/deny/defer) is what the operator needs
// to weigh. Falls back to the full set if — unexpectedly — nothing is flagged.
export function flaggedFragments(request: ShellApprovalRequest): AllowlisterFragment[] {
  const flagged = request.fragments.filter((fragment) => fragment.verdict !== "allow");
  return flagged.length > 0 ? flagged : request.fragments;
}

// The named rules that flagged this request — allowlister's own rule names, not
// inferred "risk" guesses. A `defer` fragment matched no rule, so it has none.
export function triggeredRules(request: ShellApprovalRequest): string[] {
  const rules = new Set<string>();
  for (const fragment of flaggedFragments(request)) {
    if (fragment.rule) {
      rules.add(fragment.rule);
    }
  }
  return [...rules];
}

// A short identifier for the request, used for headings and accessible labels.
export function requestHeadline(request: ApprovalRequest): string {
  if (isToolRequest(request)) {
    return request.tool.name;
  }
  const [first] = flaggedFragments(request);
  return first?.display ?? request.command;
}

// A one-line, human-readable summary of a tool call's canonical parameters,
// e.g. `path = /repo/deploy.yml` — empty when the adapter mapped none.
export function toolParamSummary(request: ToolApprovalRequest): string {
  return Object.entries(request.tool.params)
    .map(([key, value]) => `${key} = ${String(value)}`)
    .join(" · ");
}
