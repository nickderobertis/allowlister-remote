import type {
  AllowlisterFragment,
  ApprovalDecision,
  ApprovalRequest,
  ApprovalVerdict,
  ToolCall,
} from "../types";

// The plugin forwards allowlister's protocol-v2 payload verbatim (plus the
// app's own timeoutMs), so this mirrors that wire shape. Everything is unknown
// because it crosses a process boundary; we narrow it as we build the request.
type PluginPayload = {
  protocol_version?: unknown;
  subject?: unknown;
  command?: unknown;
  cwd?: unknown;
  harness?: unknown;
  current_verdict?: unknown;
  current_reason?: unknown;
  fragments?: unknown;
  tool?: unknown;
};

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

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asVerdict(value: unknown): ApprovalVerdict {
  return value === "allow" || value === "deny" || value === "ask" || value === "defer"
    ? value
    : "defer";
}

// Map allowlister's structured fragments onto our typed shape. A v2 payload
// always carries this array; we tolerate a missing/garbled one by falling back
// to a single fragment for the whole command so the UI still renders.
function readFragments(raw: unknown, command: string): AllowlisterFragment[] {
  if (!Array.isArray(raw)) {
    return command ? [wholeCommandFragment(command)] : [];
  }
  return raw.map((entry) => {
    const fragment = asRecord(entry);
    const argv = Array.isArray(fragment.argv) ? fragment.argv.map(String) : [];
    const display = typeof fragment.display === "string" ? fragment.display : argv.join(" ");
    return {
      display,
      argv,
      role: typeof fragment.role === "string" ? fragment.role : "standalone",
      verdict: asVerdict(fragment.verdict),
      rule: typeof fragment.rule === "string" ? fragment.rule : null,
      reason: typeof fragment.reason === "string" ? fragment.reason : "",
    };
  });
}

function wholeCommandFragment(command: string): AllowlisterFragment {
  return {
    display: command,
    argv: command.split(/\s+/u).filter(Boolean),
    role: "standalone",
    verdict: "ask",
    rule: null,
    reason: "",
  };
}

function readTool(raw: unknown): ToolCall {
  const tool = asRecord(raw);
  return {
    name: typeof tool.name === "string" ? tool.name : "",
    capability: typeof tool.capability === "string" ? tool.capability : "other",
    params: asRecord(tool.params),
    raw: asRecord(tool.raw),
  };
}

export function enqueuePluginRequest(input: PluginPayload, timeoutMs: number): ApprovalRequest {
  const now = Date.now();
  const base = {
    id: crypto.randomUUID(),
    protocolVersion: Number(input.protocol_version ?? 2),
    harness: String(input.harness ?? "allowlister"),
    cwd: String(input.cwd ?? ""),
    currentVerdict: asVerdict(input.current_verdict),
    currentReason: String(input.current_reason ?? ""),
    createdAt: new Date(now).toISOString(),
    // A non-positive timeout means the request waits indefinitely for either a
    // remote or a local-terminal decision, so it never expires on its own.
    expiresAt: timeoutMs > 0 ? new Date(now + timeoutMs).toISOString() : null,
  };

  const request: ApprovalRequest =
    input.subject === "tool"
      ? { ...base, subject: "tool", tool: readTool(input.tool) }
      : (() => {
          const command = String(input.command ?? "");
          return {
            ...base,
            subject: "shell",
            command,
            fragments: readFragments(input.fragments, command),
          };
        })();

  state.requests.set(request.id, request);
  return request;
}

export function listPendingRequests() {
  const now = Date.now();
  return [...state.requests.values()]
    .filter(
      (request) =>
        !state.decisions.has(request.id) &&
        (request.expiresAt === null || Date.parse(request.expiresAt) > now),
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
