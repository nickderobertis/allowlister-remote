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

// The agent's verbatim tool-call arguments as `key = value` lines — the inbox
// preview of a tool call, mirroring how a shell card previews its flagged script
// lines. Uses `raw` (what the agent actually passed), the same set the detail
// view weighs, so the operator can size up the call without opening it.
export function toolCallLines(request: ToolApprovalRequest): string[] {
  return Object.entries(request.tool.raw).map(
    ([key, value]) => `${key} = ${typeof value === "string" ? value : JSON.stringify(value)}`,
  );
}

// One source line of a shell request's script, paired with the fragment
// allowlister parsed from it (or `null` for pure structure like a `for … do`
// header's `done`, or a blank line).
export interface ScriptLine {
  text: string;
  fragment: AllowlisterFragment | null;
}

// The shell request's script reconstructed line by line, each source line paired
// with the fragment that line carries. This lets the Script view render the real
// script — loop structure and indentation intact — instead of a flat fragment
// list that drops the `for … do`/`done` scaffolding. A fragment matches the line
// whose trimmed text equals its `display`; a command-substitution fragment
// (e.g. `$(cat …)` in a `for` header) instead matches the line that contains it.
// Each fragment is consumed once, so repeated lines map to fragments in order.
export function scriptLines(request: ShellApprovalRequest): ScriptLine[] {
  const remaining = [...request.fragments];
  return request.command.split("\n").map((text) => {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return { text, fragment: null };
    }
    let index = remaining.findIndex((fragment) => fragment.display.trim() === trimmed);
    if (index === -1) {
      index = remaining.findIndex(
        (fragment) => fragment.display.trim().length > 0 && text.includes(fragment.display.trim()),
      );
    }
    const fragment = index === -1 ? null : (remaining.splice(index, 1)[0] ?? null);
    return { text, fragment };
  });
}

// The surrounding (non-flagged) lines of a shell request's script, in source
// order, for the inbox preview the operator reads beneath the flagged commands.
// The raw command split into lines, with blanks and the lines already shown as
// flagged fragments removed (compared trimmed, so dedup ignores indentation but
// display keeps it). Leaves the budget/slicing to the caller.
export function scriptContextLines(request: ShellApprovalRequest): string[] {
  const flagged = new Set(flaggedFragments(request).map((fragment) => fragment.display.trim()));
  return request.command
    .split("\n")
    .filter((line) => line.trim().length > 0 && !flagged.has(line.trim()));
}
