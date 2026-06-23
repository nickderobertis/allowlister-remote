import Image from "next/image";
import { Badge } from "@/components/ui/badge";
import type { ApprovalRequest, ApprovalVerdict } from "@/types";

// The verdict a decision applies to an approval and the callback that records it.
export type Verdict = "allow" | "deny";

export interface RequestProps {
  request: ApprovalRequest;
  onDecide: (id: string, verdict: Verdict) => void;
}

// Props shared by every detail view: whether to paint inline shortcut hints
// (desktop only) and whether the view's own keyboard shortcuts are live.
export interface DetailChromeProps {
  showHints: boolean;
  keyboardEnabled: boolean;
}

// ask/deny demand attention (red); allow and the unmatched `defer` stay neutral.
function verdictVariant(verdict: ApprovalVerdict): "destructive" | "outline" {
  return verdict === "ask" || verdict === "deny" ? "destructive" : "outline";
}

// Highlight colour for a fragment *in the script*: ask is a soft amber so the
// operator can pick out the commands that tripped the gate among the rest, and
// deny is the destructive red. Everything else — allow, an unmatched defer —
// is plain muted text with no tint. Only the script is highlighted; the flagged
// command display itself renders in standard text.
export function fragmentTone(verdict: ApprovalVerdict): string {
  switch (verdict) {
    case "ask":
      return "text-amber-700/70 dark:text-amber-400/70";
    case "deny":
      return "text-destructive";
    default:
      return "text-muted-foreground";
  }
}

export function VerdictBadge({ verdict }: { verdict: ApprovalVerdict }) {
  return <Badge variant={verdictVariant(verdict)}>{verdict}</Badge>;
}

// A small, unobtrusive brand mark: the shield logo beside the product label.
// Used in the inbox and empty-state headers so the app is recognizable without
// crowding the approval content.
export function BrandMark() {
  return (
    <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
      <Image src="/logo.png" alt="" aria-hidden width={20} height={20} className="h-5 w-5" />
      allowlister remote
    </p>
  );
}

export function Eyebrow({ request }: { request: ApprovalRequest }) {
  return (
    <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
      {request.harness} · allowlister {request.currentVerdict} · {request.subject}
    </span>
  );
}
