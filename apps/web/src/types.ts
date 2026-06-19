export type ApprovalVerdict = "allow" | "deny" | "ask" | "defer";

export interface AllowlisterFragment {
  argv: string[];
  display: string;
  role: string;
  verdict: ApprovalVerdict;
  rule?: string;
  reason?: string;
}

export interface ApprovalRequest {
  id: string;
  subject: "shell";
  harness: string;
  cwd: string;
  command: string;
  currentVerdict: ApprovalVerdict;
  currentReason: string;
  createdAt: string;
  expiresAt: string | null;
  fragments: AllowlisterFragment[];
  riskSignals: string[];
}

export interface ApprovalDecision {
  requestId: string;
  verdict: "allow" | "deny";
  reason: string;
}
