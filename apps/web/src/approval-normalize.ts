import type { AllowlisterFragment, ApprovalRequest, ApprovalVerdict, ToolCall } from "./types";

// The plugin forwards allowlister's protocol-v2 payload verbatim, so this mirrors
// that wire shape. Everything is unknown because it crosses a process boundary; we
// narrow it as we build the request. Shared by
// the HTTP store (server) and the broker bridge (client) so both paths produce
// exactly the same normalized ApprovalRequest the UI renders.
export type PluginPayload = {
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

// Build the normalized request from a raw plugin payload and an id assigned by
// the caller (a fresh uuid in the store, the daemon-assigned id over the broker).
export function normalizePluginRequest(input: PluginPayload, id: string): ApprovalRequest {
  const base = {
    id,
    protocolVersion: Number(input.protocol_version ?? 2),
    harness: String(input.harness ?? "allowlister"),
    cwd: String(input.cwd ?? ""),
    currentVerdict: asVerdict(input.current_verdict),
    currentReason: String(input.current_reason ?? ""),
  };

  return input.subject === "tool"
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
}

// Normalize a request delivered over the broker. That object is the plugin's
// `build_create_body` output: the verbatim allowlister payload plus the assigned
// `id`.
export function normalizeBrokerRequest(raw: unknown): ApprovalRequest {
  const record = asRecord(raw) as Record<string, unknown> & PluginPayload;
  const id = typeof record.id === "string" ? record.id : crypto.randomUUID();
  return normalizePluginRequest(record, id);
}
