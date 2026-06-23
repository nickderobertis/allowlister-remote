import { type ReactNode, useEffect, useRef } from "react";
import {
  flaggedFragments,
  requestHeadline,
  scriptLines,
  toolCallLines,
  triggeredRules,
} from "@/approval";
import { type BrokerStatus, ConnectionStatus } from "@/components/connection-status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import type { ApprovalRequest, ShellApprovalRequest, ToolApprovalRequest } from "@/types";
import { BrandMark, Eyebrow, fragmentTone, type RequestProps, type Verdict } from "./shared";

// A shell card has two stacked sections: the flagged commands that need approval
// (larger, coloured by verdict — at most INBOX_FLAGGED_LINES), then the full
// script for context (smaller and muted, every line in source order with the
// flagged ones in place — at most INBOX_SCRIPT_LINES). A tool card shows the tool
// name plus its arguments, INBOX_TOOL_LINES (name included) in all. The remainder
// of each section folds into a "+N more" count.
const INBOX_FLAGGED_LINES = 6;
const INBOX_SCRIPT_LINES = 12;
const INBOX_TOOL_LINES = 8;

// A small caption that titles a preview section.
function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </span>
  );
}

// A shell request's inbox preview: the flagged commands first (the operator's
// decision), then the whole script beneath as context. The two are separate,
// labelled sections so the flagged commands read as the action and the script
// reads as where they sit — and nothing the engine flagged ever disappears from
// the script, because the script section renders every line in place.
function ShellPreview({ request }: { request: ShellApprovalRequest }) {
  const flagged = flaggedFragments(request);
  const shownFlagged = flagged.slice(0, INBOX_FLAGGED_LINES);
  const hiddenFlagged = flagged.length - shownFlagged.length;
  // The whole command, line by line (blank lines dropped); flagged lines keep
  // their place so the loop body never looks like it lost a command.
  const lines = scriptLines(request).filter((line) => line.text.trim().length > 0);
  const shownLines = lines.slice(0, INBOX_SCRIPT_LINES);
  const hiddenLines = lines.length - shownLines.length;
  // A single-line command is wholly the flagged command, so the script section
  // would just echo it — show it only when there is more than one line.
  const showScript = lines.length > 1;

  return (
    <span className="flex w-full min-w-0 flex-col gap-3">
      <span className="flex min-w-0 flex-col gap-1">
        <SectionLabel>Flagged</SectionLabel>
        {shownFlagged.map((fragment) => (
          <code
            className="min-w-0 whitespace-pre-wrap break-words font-mono text-sm text-foreground sm:text-base"
            key={`${fragment.role}-${fragment.display}`}
          >
            {fragment.display}
          </code>
        ))}
        {hiddenFlagged > 0 ? (
          <span className="text-xs text-muted-foreground">
            +{hiddenFlagged} more flagged command(s)
          </span>
        ) : null}
      </span>
      {showScript ? (
        <span className="flex min-w-0 flex-col gap-0.5 border-t border-border/60 pt-2">
          <SectionLabel>Script</SectionLabel>
          {shownLines.map((line, index) => (
            <code
              className={cn(
                "min-w-0 whitespace-pre-wrap break-words font-mono text-xs",
                line.fragment ? fragmentTone(line.fragment.verdict) : "text-muted-foreground",
              )}
              // biome-ignore lint/suspicious/noArrayIndexKey: lines are a stable, ordered render of one immutable command
              key={`line-${index}`}
            >
              {line.text}
            </code>
          ))}
          {hiddenLines > 0 ? (
            <span className="text-xs text-muted-foreground">
              +{hiddenLines} more script line(s)
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

// A tool request's inbox preview: the tool name plus the verbatim arguments the
// agent passed, INBOX_TOOL_LINES in all (the name counts as one).
function ToolPreview({ request }: { request: ToolApprovalRequest }) {
  const lines = toolCallLines(request);
  const shown = lines.slice(0, INBOX_TOOL_LINES - 1);
  const hidden = lines.length - shown.length;
  return (
    <span className="flex w-full min-w-0 flex-col gap-1">
      <code className="min-w-0 break-words font-mono text-sm text-foreground sm:text-base">
        {request.tool.name}
      </code>
      {shown.map((line) => (
        <code className="min-w-0 break-words font-mono text-sm text-muted-foreground" key={line}>
          {line}
        </code>
      ))}
      {hidden > 0 ? (
        <span className="text-xs text-muted-foreground">+{hidden} more argument(s)</span>
      ) : null}
    </span>
  );
}

// The card's inline preview, dispatched on the request's subject so the operator
// can size up the request's own data without opening it.
function InboxPreview({ request }: { request: ApprovalRequest }) {
  return request.subject === "shell" ? (
    <ShellPreview request={request} />
  ) : (
    <ToolPreview request={request} />
  );
}

// The card's badges row: a tool request shows its capability; a shell request
// shows the named rules that fired, or that it deferred to remote approval.
function InboxBadges({ request }: { request: ApprovalRequest }) {
  if (request.subject === "tool") {
    return <Badge variant="outline">{request.tool.capability}</Badge>;
  }
  const rules = triggeredRules(request);
  if (rules.length === 0) {
    return <Badge variant="outline">deferred to remote approval</Badge>;
  }
  return (
    <>
      {rules.map((rule) => (
        <Badge variant="destructive" key={rule}>
          {rule}
        </Badge>
      ))}
    </>
  );
}

function InboxItem({
  request,
  focused,
  showHints,
  onOpen,
  onFocus,
  onDecide,
}: RequestProps & {
  focused: boolean;
  showHints: boolean;
  onOpen: (id: string) => void;
  onFocus: () => void;
}) {
  const headline = requestHeadline(request);
  const itemRef = useRef<HTMLLIElement>(null);
  // The keyboard cursor: keep the focused card visible as the arrows walk the list.
  const highlighted = focused && showHints;

  useEffect(() => {
    if (highlighted) {
      itemRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [highlighted]);

  return (
    <li ref={itemRef}>
      <Card
        onMouseEnter={onFocus}
        className={cn(
          "flex flex-col gap-4 p-4 sm:flex-row sm:items-stretch sm:justify-between",
          highlighted ? "ring-2 ring-ring" : undefined,
        )}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 flex-col items-start gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Open approval for ${headline}`}
          aria-current={highlighted ? "true" : undefined}
          onClick={() => onOpen(request.id)}
        >
          <Eyebrow request={request} />
          <InboxPreview request={request} />
          <span className="flex flex-wrap gap-1.5">
            <InboxBadges request={request} />
          </span>
        </button>

        <div className="flex items-center justify-end gap-3 sm:flex-col sm:justify-center">
          <Button
            variant="outline"
            size="sm"
            className="h-11 flex-1 px-5 text-sm sm:h-8 sm:flex-none sm:px-3 sm:text-xs"
            aria-label={`Deny ${headline}`}
            onClick={() => onDecide(request.id, "deny")}
          >
            Deny
            {highlighted ? <Kbd>D</Kbd> : null}
          </Button>
          <Button
            size="sm"
            className="h-11 flex-1 px-5 text-sm sm:h-8 sm:flex-none sm:px-3 sm:text-xs"
            aria-label={`Allow ${headline}`}
            onClick={() => onDecide(request.id, "allow")}
          >
            Allow
            {highlighted ? <Kbd>A</Kbd> : null}
          </Button>
        </div>
      </Card>
    </li>
  );
}

function InboxHints() {
  return (
    <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <Kbd>↑</Kbd>
      <Kbd>↓</Kbd>
      <span>move</span>
      <Kbd>Enter</Kbd>
      <span>open</span>
      <Kbd>A</Kbd>
      <span>allow</span>
      <Kbd>D</Kbd>
      <span>deny</span>
      <span aria-hidden="true">·</span>
      <Kbd>?</Kbd>
      <span>all shortcuts</span>
    </p>
  );
}

function ErrorBanner({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p className="text-destructive" role="alert">
      {error}
    </p>
  );
}

// The resting state with no pending approvals. When `error` is set (no service
// worker) it leads with that; otherwise it surfaces the live broker connection so
// an idle inbox is visibly distinct from one that never connected.
export function EmptyInbox({ error, status }: { error: string | null; status?: BrokerStatus }) {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-3 p-8">
      <BrandMark />
      {status ? <ConnectionStatus status={status} /> : null}
      <h1 className="text-2xl font-semibold tracking-tight">No pending approvals</h1>
      <p className="text-muted-foreground">
        Install this PWA on your desktop or phone and keep it ready for the next agent request.
      </p>
      <ErrorBanner error={error} />
    </main>
  );
}

export function InboxView({
  requests,
  focusedIndex,
  isDesktop,
  status,
  onOpen,
  onFocus,
  onDecide,
}: {
  requests: ApprovalRequest[];
  focusedIndex: number;
  isDesktop: boolean;
  status: BrokerStatus;
  onOpen: (id: string) => void;
  onFocus: (index: number) => void;
  onDecide: (id: string, verdict: Verdict) => void;
}) {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-4 sm:p-8">
      <header className="flex flex-col gap-1">
        <BrandMark />
        <ConnectionStatus status={status} />
        <h1 className="text-2xl font-semibold tracking-tight">Approvals inbox</h1>
        <p className="text-sm text-muted-foreground">
          {requests.length} pending {requests.length === 1 ? "approval" : "approvals"} ·{" "}
          {isDesktop ? "use the keyboard or tap a card" : "tap a card"} to expand
        </p>
        {isDesktop ? <InboxHints /> : null}
      </header>

      <ul className="flex flex-col gap-3" aria-label="Pending approvals">
        {requests.map((request, index) => (
          <InboxItem
            key={request.id}
            request={request}
            focused={index === focusedIndex}
            showHints={isDesktop}
            onOpen={onOpen}
            onFocus={() => onFocus(index)}
            onDecide={onDecide}
          />
        ))}
      </ul>
    </main>
  );
}
