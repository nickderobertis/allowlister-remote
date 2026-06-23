import Image from "next/image";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  flaggedFragments,
  requestHeadline,
  scriptLines,
  toolCallLines,
  triggeredRules,
} from "./approval";
import { normalizeBrokerRequest } from "./approval-normalize";
import { ThemeToggle } from "./components/theme-toggle";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { JsonView } from "./components/ui/json-view";
import { Kbd } from "./components/ui/kbd";
import { brokerWsUrl, resolveBrokerBase, setStoredBrokerBase } from "./lib/broker-config";
import { SHORTCUT_GROUPS, useIsDesktop, useKeyboardShortcuts } from "./lib/keyboard";
import { ThemeProvider } from "./lib/theme";
import { cn } from "./lib/utils";
import { connectBroker } from "./pwa/broker-bridge";
import {
  type ApprovalRequest,
  type ApprovalVerdict,
  isToolRequest,
  type ShellApprovalRequest,
  type ToolApprovalRequest,
} from "./types";

type Verdict = "allow" | "deny";

interface RequestProps {
  request: ApprovalRequest;
  onDecide: (id: string, verdict: Verdict) => void;
}

// Props shared by every detail view: whether to paint inline shortcut hints
// (desktop only) and whether the view's own keyboard shortcuts are live.
interface DetailChromeProps {
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
function fragmentTone(verdict: ApprovalVerdict): string {
  switch (verdict) {
    case "ask":
      return "text-amber-700/70 dark:text-amber-400/70";
    case "deny":
      return "text-destructive";
    default:
      return "text-muted-foreground";
  }
}

function VerdictBadge({ verdict }: { verdict: ApprovalVerdict }) {
  return <Badge variant={verdictVariant(verdict)}>{verdict}</Badge>;
}

// A small, unobtrusive brand mark: the shield logo beside the product label.
// Used in the inbox and empty-state headers so the app is recognizable without
// crowding the approval content.
function BrandMark() {
  return (
    <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
      <Image src="/logo.png" alt="" aria-hidden width={20} height={20} className="h-5 w-5" />
      allowlister remote
    </p>
  );
}

function Eyebrow({ request }: { request: ApprovalRequest }) {
  return (
    <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
      {request.harness} · allowlister {request.currentVerdict} · {request.subject}
    </span>
  );
}

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

function DetailHero({ request, title }: { request: ApprovalRequest; title: string }) {
  return (
    <section className="flex flex-col gap-2" aria-labelledby="approval-title">
      <Eyebrow request={request} />
      <h1 id="approval-title" className="text-2xl font-semibold tracking-tight">
        {title}
      </h1>
      <p className="text-muted-foreground">{request.currentReason}</p>
    </section>
  );
}

function ContextCard({ request, children }: { request: ApprovalRequest; children?: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Context</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Harness</dt>
            <dd className="font-mono text-sm">{request.harness}</dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Session</dt>
            <dd className="font-mono text-sm">{request.sessionId ?? "no session"}</dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">
              Working directory
            </dt>
            <dd className="font-mono text-sm">{request.cwd}</dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Request id</dt>
            <dd className="font-mono text-sm">{request.id}</dd>
          </div>
        </dl>
        {children}
      </CardContent>
    </Card>
  );
}

function BackButton({ showHints, onBack }: { showHints: boolean; onBack: () => void }) {
  return (
    <Button variant="ghost" size="sm" className="self-start" onClick={onBack}>
      <span>← All approvals</span>
      {showHints ? <Kbd>Esc</Kbd> : null}
    </Button>
  );
}

function DecisionBar({
  request,
  showHints,
  onDecide,
}: {
  request: ApprovalRequest;
  showHints: boolean;
  onDecide: RequestProps["onDecide"];
}) {
  return (
    <footer className="flex gap-4">
      <Button
        variant="outline"
        className="h-12 flex-1 text-base sm:h-10 sm:text-sm"
        aria-label="Deny"
        onClick={() => onDecide(request.id, "deny")}
      >
        Deny
        {showHints ? <Kbd>D</Kbd> : null}
      </Button>
      <Button
        className="h-12 flex-1 text-base sm:h-10 sm:text-sm"
        aria-label="Allow once"
        onClick={() => onDecide(request.id, "allow")}
      >
        Allow once
        {showHints ? <Kbd>A</Kbd> : null}
      </Button>
    </footer>
  );
}

// The interactive script: the real script rendered line by line — loop structure
// and indentation intact — each line coloured by the permission of the fragment
// allowlister parsed from it. A line that carries a fragment is a button: clicking
// it reveals that fragment's role, rule, and reason so the operator can drill in
// without leaving the script. Pure-structure lines (a `for … do` header's `done`)
// render muted and inert so the loop still reads as one block.
function ShellScript({ request }: { request: ShellApprovalRequest }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const lines = scriptLines(request);

  return (
    <Card aria-label="Script">
      <CardHeader>
        <CardTitle>Script</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col">
          {lines.map((line, index) => {
            if (line.text.trim().length === 0) {
              return null;
            }
            const { fragment } = line;
            const open = openIndex === index;
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: lines are a stable, ordered render of one immutable command
              <li key={`line-${index}`}>
                {!fragment ? (
                  // Pure structure (a `for … do` header's `done`): muted and inert.
                  <code className="block whitespace-pre-wrap break-words px-2 py-0.5 font-mono text-sm text-muted-foreground">
                    {line.text}
                  </code>
                ) : (
                  <>
                    <button
                      type="button"
                      aria-expanded={open}
                      aria-label={`${line.text.trim()} — ${fragment.verdict}`}
                      className="flex w-full rounded-md px-2 py-0.5 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => setOpenIndex(open ? null : index)}
                    >
                      <code
                        className={cn(
                          "min-w-0 whitespace-pre-wrap break-words font-mono text-sm",
                          fragmentTone(fragment.verdict),
                        )}
                      >
                        {line.text}
                      </code>
                    </button>
                    {open ? (
                      <dl className="flex flex-col gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm">
                        <div className="flex items-center justify-between gap-2">
                          <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                            Verdict
                          </dt>
                          <dd>
                            <VerdictBadge verdict={fragment.verdict} />
                          </dd>
                        </div>
                        <div className="flex flex-col gap-0.5">
                          <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                            Role
                          </dt>
                          <dd className="font-mono text-sm">{fragment.role}</dd>
                        </div>
                        <div className="flex flex-col gap-0.5">
                          <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                            Rule
                          </dt>
                          <dd className="font-mono text-sm">
                            {fragment.rule ?? "no matching rule"}
                          </dd>
                        </div>
                        {fragment.reason ? (
                          <div className="flex flex-col gap-0.5">
                            <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                              Reason
                            </dt>
                            <dd className="text-sm text-muted-foreground">{fragment.reason}</dd>
                          </div>
                        ) : null}
                      </dl>
                    ) : null}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

function ShellDetail({
  request,
  showHints,
  onBack,
  onDecide,
}: { request: ShellApprovalRequest } & Omit<RequestProps, "request"> &
  DetailChromeProps & { onBack: () => void }) {
  const flagged = flaggedFragments(request);

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-4 sm:p-8">
      <BackButton showHints={showHints} onBack={onBack} />

      <DetailHero request={request} title="Approve shell command" />

      <Card aria-label="Flagged commands">
        <CardContent className="flex flex-col gap-2 p-4">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Needs your attention
          </span>
          {flagged.map((fragment) => (
            <div className="flex min-w-0 flex-col gap-1" key={`flagged-${fragment.display}`}>
              <code className="min-w-0 break-words font-mono text-base text-foreground">
                {fragment.display}
              </code>
              {fragment.rule ? (
                <small className="text-xs text-muted-foreground">{fragment.rule}</small>
              ) : null}
            </div>
          ))}
        </CardContent>
      </Card>

      <ShellScript request={request} />

      <ContextCard request={request} />

      <DecisionBar request={request} showHints={showHints} onDecide={onDecide} />
    </main>
  );
}

function ToolDetail({
  request,
  showHints,
  keyboardEnabled,
  onBack,
  onDecide,
}: { request: ToolApprovalRequest } & Omit<RequestProps, "request"> &
  DetailChromeProps & { onBack: () => void }) {
  const [view, setView] = useState<"formatted" | "json">("formatted");
  // The arguments the agent actually passed — the one set the operator weighs.
  const args = Object.entries(request.tool.raw);

  useKeyboardShortcuts(
    { f: () => setView("formatted"), j: () => setView("json") },
    keyboardEnabled,
  );

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-4 sm:p-8">
      <BackButton showHints={showHints} onBack={onBack} />

      <DetailHero request={request} title="Approve this tool call" />

      <Card aria-label="Tool call">
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="min-w-0">
            <code className="font-mono text-base break-words">{request.tool.name}</code>
          </CardTitle>
          <div className="flex shrink-0 gap-1">
            <Button
              variant={view === "formatted" ? "default" : "outline"}
              size="sm"
              aria-label="Formatted"
              aria-pressed={view === "formatted"}
              onClick={() => setView("formatted")}
            >
              Formatted
              {showHints ? <Kbd>F</Kbd> : null}
            </Button>
            <Button
              variant={view === "json" ? "default" : "outline"}
              size="sm"
              aria-label="JSON"
              aria-pressed={view === "json"}
              onClick={() => setView("json")}
            >
              JSON
              {showHints ? <Kbd>J</Kbd> : null}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {view === "formatted" ? (
            <section className="flex flex-col gap-4" aria-label="Tool call formatted view">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">capability: {request.tool.capability}</Badge>
              </div>
              <ToolKeyValues title="Arguments" entries={args} />
            </section>
          ) : (
            <section aria-label="Tool call JSON view">
              <JsonView value={request.tool.raw} />
            </section>
          )}
        </CardContent>
      </Card>

      <ContextCard request={request} />

      <DecisionBar request={request} showHints={showHints} onDecide={onDecide} />
    </main>
  );
}

function ToolKeyValues({ title, entries }: { title: string; entries: [string, unknown][] }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </span>
      {entries.length === 0 ? (
        <span className="text-sm text-muted-foreground">none</span>
      ) : (
        <dl className="flex flex-col gap-2">
          {entries.map(([key, value]) => (
            <div className="flex flex-col gap-0.5" key={key}>
              <dt className="font-mono text-xs text-muted-foreground">{key}</dt>
              <dd className="font-mono text-sm text-foreground">
                {typeof value === "string" ? value : JSON.stringify(value)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function ApprovalDetail({
  request,
  showHints,
  keyboardEnabled,
  onBack,
  onDecide,
}: RequestProps & DetailChromeProps & { onBack: () => void }) {
  // Allow / deny / back work the same for both subjects, so bind them once here;
  // the tool view binds its own extra keys (F/J for formatted/JSON).
  useKeyboardShortcuts(
    {
      a: () => onDecide(request.id, "allow"),
      d: () => onDecide(request.id, "deny"),
      b: onBack,
      Escape: onBack,
    },
    keyboardEnabled,
  );

  if (isToolRequest(request)) {
    return (
      <ToolDetail
        request={request}
        showHints={showHints}
        keyboardEnabled={keyboardEnabled}
        onBack={onBack}
        onDecide={onDecide}
      />
    );
  }
  return (
    <ShellDetail
      request={request}
      showHints={showHints}
      keyboardEnabled={keyboardEnabled}
      onBack={onBack}
      onDecide={onDecide}
    />
  );
}

function ShortcutsHint({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="fixed bottom-4 right-4 z-40">
      <Button variant="outline" size="sm" onClick={onOpen} aria-label="Show keyboard shortcuts">
        Shortcuts
        <Kbd>?</Kbd>
      </Button>
    </div>
  );
}

function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="shortcuts-title"
    >
      <Card className="max-h-full w-full max-w-lg overflow-y-auto">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle id="shortcuts-title">Keyboard shortcuts</CardTitle>
          <Button variant="ghost" size="sm" aria-label="Close shortcuts" onClick={onClose}>
            Close
            <Kbd>Esc</Kbd>
          </Button>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group.title} className="flex flex-col gap-2">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {group.title}
              </h3>
              <dl className="flex flex-col gap-1.5">
                {group.shortcuts.map((shortcut) => (
                  <div
                    key={shortcut.description}
                    className="flex items-center justify-between gap-4"
                  >
                    <dt className="text-sm text-foreground">{shortcut.description}</dt>
                    <dd className="flex shrink-0 items-center gap-1">
                      {shortcut.keys.map((key) => (
                        <Kbd key={key}>{key}</Kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </CardContent>
      </Card>
    </div>
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

function EmptyInbox({ error }: { error: string | null }) {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-3 p-8">
      <BrandMark />
      <h1 className="text-2xl font-semibold tracking-tight">No pending approvals</h1>
      <p className="text-muted-foreground">
        Install this PWA on your desktop or phone and keep it ready for the next agent request.
      </p>
      <ErrorBanner error={error} />
    </main>
  );
}

// Shown when no broker is configured yet. The PWA is fully static, so the broker
// URL is a setting this device holds (saved to localStorage); the app derives the
// `/ws/pwa` endpoint from it. A `?broker=` deep link skips this screen entirely.
function BrokerSetup({ onSave }: { onSave: (base: string) => void }) {
  const [value, setValue] = useState("");
  const trimmed = value.trim();
  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 p-8">
      <BrandMark />
      <h1 className="text-2xl font-semibold tracking-tight">Connect to your broker</h1>
      <p className="text-muted-foreground">
        allowlister-remote relays approval requests through a broker you run. Enter its URL to
        connect this device — it is saved on this device only.
      </p>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed) onSave(trimmed);
        }}
      >
        <label className="flex flex-col gap-1 text-sm font-medium" htmlFor="broker-url">
          Broker URL
          <input
            id="broker-url"
            name="broker-url"
            type="url"
            inputMode="url"
            autoComplete="off"
            placeholder="wss://broker.example.com"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            className="rounded-md border border-border bg-background px-3 py-2 text-sm font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          />
        </label>
        <Button type="submit" disabled={trimmed.length === 0}>
          Connect
        </Button>
      </form>
      <p className="text-xs text-muted-foreground">
        Tip: open this app with <code>?broker=wss://…</code> to set the broker automatically.
      </p>
    </main>
  );
}

function InboxView({
  requests,
  focusedIndex,
  isDesktop,
  onOpen,
  onFocus,
  onDecide,
}: {
  requests: ApprovalRequest[];
  focusedIndex: number;
  isDesktop: boolean;
  onOpen: (id: string) => void;
  onFocus: (index: number) => void;
  onDecide: (id: string, verdict: Verdict) => void;
}) {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-4 sm:p-8">
      <header className="flex flex-col gap-1">
        <BrandMark />
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

function App() {
  const [requests, setRequests] = useState<ApprovalRequest[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [showShortcuts, setShowShortcuts] = useState(false);
  // The configured broker base, and where the app is in its one-time boot: until
  // it resolves (a client-only read of navigator.serviceWorker, localStorage and
  // the URL) the app shows a neutral empty shell, so the static-export prerender
  // and the first client render match. Then it is either unsupported (no service
  // worker), awaiting a broker URL, or ready to connect.
  const [brokerBase, setBrokerBase] = useState<string | null>(null);
  const [bootState, setBootState] = useState<"resolving" | "no-sw" | "needs-broker" | "ready">(
    "resolving",
  );
  const isDesktop = useIsDesktop();
  // Decisions travel back through the broker to the waiting plugin (the request
  // lives in the broker, never on the web server). Held in a ref so `decide` can
  // reach it without re-rendering on connect.
  const brokerRef = useRef<{
    decide: (decision: { requestId: string; verdict: "allow" | "deny"; reason: string }) => void;
    close: () => void;
  } | null>(null);

  // Resolve the runtime environment once on mount. This reads browser-only state
  // (the service worker, the saved broker setting, the URL), so it lives in an
  // effect rather than during render.
  useEffect(() => {
    if (!navigator.serviceWorker) {
      setBootState("no-sw");
      return;
    }
    const base = resolveBrokerBase();
    setBrokerBase(base);
    setBootState(base ? "ready" : "needs-broker");
  }, []);

  // The broker is the sole source of approval requests: the service worker holds
  // one WebSocket to it and relays every live update, so approvals appear and
  // dismiss the moment the daemon announces or resolves them. There is no polling
  // or HTTP fallback — without a configured broker the app shows its setup screen
  // instead. Re-runs when the user saves a new broker URL.
  useEffect(() => {
    if (bootState !== "ready" || !brokerBase) return;
    const bridge = connectBroker(brokerWsUrl(brokerBase), {
      onSnapshot: (snapshot) => setRequests(snapshot.map(normalizeBrokerRequest)),
      onAdded: (request) =>
        setRequests((current) => {
          const normalized = normalizeBrokerRequest(request);
          // Dedupe by id so a re-announce (e.g. after a broker restart) never
          // double-renders a card.
          return current.some((existing) => existing.id === normalized.id)
            ? current
            : [...current, normalized];
        }),
      onResolved: (id) => setRequests((current) => current.filter((request) => request.id !== id)),
    });
    brokerRef.current = bridge;
    return () => {
      bridge.close();
      brokerRef.current = null;
    };
  }, [bootState, brokerBase]);

  // Persist a broker URL entered on the setup screen, then connect to it.
  function saveBrokerBase(base: string) {
    setStoredBrokerBase(base);
    setBrokerBase(base);
    setBootState("ready");
  }

  const selected = useMemo(
    () => requests.find((request) => request.id === selectedId) ?? null,
    [requests, selectedId],
  );

  // Keep the inbox cursor in range as requests resolve or new ones arrive.
  useEffect(() => {
    setFocusedIndex((index) => Math.min(index, Math.max(0, requests.length - 1)));
  }, [requests.length]);

  function decide(id: string, verdict: Verdict) {
    const decision = { requestId: id, verdict, reason: `${verdict}ed in allowlister-remote` };
    // Route the decision back through the broker to the plugin waiting there, then
    // drop the card optimistically; the broker's `resolved` event confirms it.
    brokerRef.current?.decide(decision);
    setRequests((current) => current.filter((request) => request.id !== id));
    setSelectedId((current) => (current === id ? null : current));
  }

  // Named handlers keep the shortcut maps below free of inline definitions.
  const togglePanel = () => setShowShortcuts((open) => !open);
  const closePanel = () => setShowShortcuts(false);
  const focusNext = () => setFocusedIndex((index) => Math.min(index + 1, requests.length - 1));
  const focusPrev = () => setFocusedIndex((index) => Math.max(index - 1, 0));
  const openFocused = () => {
    const request = requests[focusedIndex];
    if (request) setSelectedId(request.id);
  };
  const decideFocused = (verdict: Verdict) => {
    const request = requests[focusedIndex];
    if (request) void decide(request.id, verdict);
  };

  // Toggle the shortcuts panel from anywhere on desktop.
  useKeyboardShortcuts({ "?": togglePanel }, isDesktop);
  // While the panel is open, Escape closes it and every other shortcut pauses.
  useKeyboardShortcuts({ Escape: closePanel }, isDesktop && showShortcuts);
  // Inbox navigation, only while a list is showing and nothing is layered on top.
  const inboxActive = isDesktop && !selected && !showShortcuts && requests.length > 0;
  useKeyboardShortcuts(
    {
      ArrowDown: focusNext,
      ArrowUp: focusPrev,
      o: openFocused,
      Enter: openFocused,
      a: () => decideFocused("allow"),
      d: () => decideFocused("deny"),
    },
    inboxActive,
  );

  let content: ReactNode;
  if (bootState === "no-sw") {
    content = (
      <EmptyInbox error="This browser has no service worker, which allowlister-remote requires." />
    );
  } else if (bootState === "needs-broker") {
    content = <BrokerSetup onSave={saveBrokerBase} />;
  } else if (selected) {
    content = (
      <ApprovalDetail
        request={selected}
        showHints={isDesktop}
        keyboardEnabled={isDesktop && !showShortcuts}
        onBack={() => setSelectedId(null)}
        onDecide={decide}
      />
    );
  } else if (requests.length === 0) {
    content = <EmptyInbox error={null} />;
  } else {
    content = (
      <InboxView
        requests={requests}
        focusedIndex={focusedIndex}
        isDesktop={isDesktop}
        onOpen={setSelectedId}
        onFocus={setFocusedIndex}
        onDecide={decide}
      />
    );
  }

  return (
    <ThemeProvider>
      <div className="fixed right-4 top-4 z-40">
        <ThemeToggle />
      </div>
      {content}
      {isDesktop && !showShortcuts ? <ShortcutsHint onOpen={() => setShowShortcuts(true)} /> : null}
      {isDesktop && showShortcuts ? (
        <ShortcutsOverlay onClose={() => setShowShortcuts(false)} />
      ) : null}
    </ThemeProvider>
  );
}

export default App;
