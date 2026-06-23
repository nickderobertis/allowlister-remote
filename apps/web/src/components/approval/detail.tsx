import { type ReactNode, useState } from "react";
import { flaggedFragments, scriptLines } from "@/approval";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { JsonView } from "@/components/ui/json-view";
import { Kbd } from "@/components/ui/kbd";
import { useKeyboardShortcuts } from "@/lib/keyboard";
import { cn } from "@/lib/utils";
import {
  type ApprovalRequest,
  isToolRequest,
  type ShellApprovalRequest,
  type ToolApprovalRequest,
} from "@/types";
import {
  type DetailChromeProps,
  Eyebrow,
  fragmentTone,
  type RequestProps,
  VerdictBadge,
} from "./shared";

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

export function ApprovalDetail({
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
