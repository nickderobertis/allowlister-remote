export type ApprovalVerdict = "allow" | "deny" | "ask" | "defer";

// Roles allowlister tags shell fragments with as it walks the bash AST. Kept as
// a string (not a closed union) so a future allowlister can add roles without
// breaking the app; the known set is exported for display logic.
export type FragmentRole =
  | "standalone"
  | "pipe_source"
  | "pipe_filter"
  | "subshell"
  | "substitution";

// One role-tagged command from allowlister's structural decomposition. These are
// delivered verbatim in the plugin payload (protocol v2) — the app no longer
// guesses fragments by splitting on shell operators.
export interface AllowlisterFragment {
  display: string;
  argv: string[];
  role: string;
  verdict: ApprovalVerdict;
  // null when no rule matched (a `defer`), otherwise the matching rule's name.
  rule: string | null;
  reason: string;
}

// A non-shell tool invocation (a capability like read/write/edit or an MCP tool
// such as `mcp__github__create_issue`), as allowlister maps it for plugins.
export interface ToolCall {
  name: string;
  capability: string;
  // Canonical scalar parameters the harness adapter mapped (path/url/query/…).
  params: Record<string, unknown>;
  // The original tool-input object, verbatim.
  raw: Record<string, unknown>;
}

interface ApprovalRequestBase {
  id: string;
  protocolVersion: number;
  harness: string;
  cwd: string;
  currentVerdict: ApprovalVerdict;
  currentReason: string;
  createdAt: string;
  expiresAt: string | null;
}

export interface ShellApprovalRequest extends ApprovalRequestBase {
  subject: "shell";
  command: string;
  fragments: AllowlisterFragment[];
}

export interface ToolApprovalRequest extends ApprovalRequestBase {
  subject: "tool";
  tool: ToolCall;
}

export type ApprovalRequest = ShellApprovalRequest | ToolApprovalRequest;

export function isShellRequest(request: ApprovalRequest): request is ShellApprovalRequest {
  return request.subject === "shell";
}

export function isToolRequest(request: ApprovalRequest): request is ToolApprovalRequest {
  return request.subject === "tool";
}

export interface ApprovalDecision {
  requestId: string;
  verdict: "allow" | "deny";
  reason: string;
}
