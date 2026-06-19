import { type ReactNode, useEffect, useMemo, useState } from "react";
import { createApprovalApi } from "./api";
import {
  flaggedFragments,
  remainingDisplay,
  requestHeadline,
  toolParamSummary,
  triggeredRules,
} from "./approval";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
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
  now: number;
  onDecide: (id: string, verdict: Verdict) => void;
}

// ask/deny demand attention (red); allow and the unmatched `defer` stay neutral.
function verdictVariant(verdict: ApprovalVerdict): "destructive" | "outline" {
  return verdict === "ask" || verdict === "deny" ? "destructive" : "outline";
}

function VerdictBadge({ verdict }: { verdict: ApprovalVerdict }) {
  return <Badge variant={verdictVariant(verdict)}>{verdict}</Badge>;
}

function Eyebrow({ request }: { request: ApprovalRequest }) {
  return (
    <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
      {request.harness} · allowlister {request.currentVerdict} · {request.subject}
    </span>
  );
}

function InboxItem({
  request,
  now,
  onOpen,
  onDecide,
}: RequestProps & { onOpen: (id: string) => void }) {
  const headline = requestHeadline(request);
  const remaining = remainingDisplay(request, now);
  const flaggedCount = request.subject === "shell" ? flaggedFragments(request).length : 0;
  const rules = request.subject === "shell" ? triggeredRules(request) : [];

  return (
    <li>
      <Card className="flex flex-col gap-4 p-4 sm:flex-row sm:items-stretch sm:justify-between">
        <button
          type="button"
          className="flex flex-1 flex-col items-start gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Open approval for ${headline}`}
          onClick={() => onOpen(request.id)}
        >
          <Eyebrow request={request} />
          <code className="font-mono text-base text-foreground">{headline}</code>
          {flaggedCount > 1 ? (
            <span className="text-xs text-muted-foreground">
              +{flaggedCount - 1} more flagged command(s)
            </span>
          ) : null}
          <span className="text-sm text-muted-foreground">{request.currentReason}</span>
          <span className="flex flex-wrap gap-1.5">
            {request.subject === "tool" ? (
              <Badge variant="outline">{request.tool.capability}</Badge>
            ) : rules.length === 0 ? (
              <Badge variant="outline">deferred to remote approval</Badge>
            ) : (
              rules.map((rule) => (
                <Badge variant="destructive" key={rule}>
                  {rule}
                </Badge>
              ))
            )}
          </span>
        </button>

        <div className="flex items-center justify-between gap-3 sm:flex-col sm:items-end sm:justify-center">
          <span
            className="font-mono text-sm text-muted-foreground"
            role="timer"
            aria-label={`${remaining.label} for ${headline}`}
          >
            {remaining.compact}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              aria-label={`Deny ${headline}`}
              onClick={() => onDecide(request.id, "deny")}
            >
              Deny
            </Button>
            <Button
              size="sm"
              aria-label={`Allow ${headline}`}
              onClick={() => onDecide(request.id, "allow")}
            >
              Allow
            </Button>
          </div>
        </div>
      </Card>
    </li>
  );
}

function DetailHero({
  request,
  now,
  title,
}: {
  request: ApprovalRequest;
  now: number;
  title: string;
}) {
  const remaining = remainingDisplay(request, now);
  return (
    <section
      className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"
      aria-labelledby="approval-title"
    >
      <div className="flex flex-col gap-2">
        <Eyebrow request={request} />
        <h1 id="approval-title" className="text-2xl font-semibold tracking-tight">
          {title}
        </h1>
        <p className="text-muted-foreground">{request.currentReason}</p>
      </div>
      <div
        className="flex shrink-0 flex-col items-center rounded-lg border border-border px-4 py-3"
        role="timer"
        aria-label={remaining.label}
      >
        <span className="font-mono text-2xl">{remaining.value}</span>
        <small className="text-xs text-muted-foreground">{remaining.unit}</small>
      </div>
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

function DecisionBar({
  request,
  onDecide,
}: {
  request: ApprovalRequest;
  onDecide: RequestProps["onDecide"];
}) {
  return (
    <footer className="flex gap-3">
      <Button variant="outline" className="flex-1" onClick={() => onDecide(request.id, "deny")}>
        Deny
      </Button>
      <Button className="flex-1" onClick={() => onDecide(request.id, "allow")}>
        Allow once
      </Button>
    </footer>
  );
}

function ShellDetail({
  request,
  now,
  onBack,
  onDecide,
}: { request: ShellApprovalRequest } & Omit<RequestProps, "request"> & { onBack: () => void }) {
  const flagged = flaggedFragments(request);

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-4 sm:p-8">
      <Button variant="ghost" size="sm" className="self-start" onClick={onBack}>
        ← All approvals
      </Button>

      <DetailHero request={request} now={now} title="Approve the action, not the wall of shell" />

      <Card aria-label="Flagged commands">
        <CardContent className="flex flex-col gap-2 p-4">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Needs your attention
          </span>
          {flagged.map((fragment) => (
            <div className="flex flex-col gap-1" key={`flagged-${fragment.display}`}>
              <code className="font-mono text-base text-foreground">{fragment.display}</code>
              {fragment.rule ? (
                <small className="text-xs text-muted-foreground">{fragment.rule}</small>
              ) : null}
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card aria-label="Allowlister fragments">
          <CardHeader>
            <CardTitle>Parsed allowlister fragments</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-3">
              {request.fragments.map((fragment) => (
                <li
                  className={
                    fragment.verdict === "allow"
                      ? "flex flex-col gap-1 rounded-md border border-transparent p-2"
                      : "flex flex-col gap-1 rounded-md border border-destructive/40 bg-destructive/5 p-2"
                  }
                  key={`${fragment.role}-${fragment.display}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <code className="font-mono text-sm text-foreground">{fragment.display}</code>
                    <VerdictBadge verdict={fragment.verdict} />
                  </div>
                  <small className="text-xs text-muted-foreground">
                    {fragment.role}
                    {fragment.rule ? ` · ${fragment.rule}` : ""}
                  </small>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
        <ContextCard request={request}>
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">Show full script</summary>
            <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-background p-3 text-xs">
              {request.command}
            </pre>
          </details>
        </ContextCard>
      </div>

      <DecisionBar request={request} onDecide={onDecide} />
    </main>
  );
}

function ToolDetail({
  request,
  now,
  onBack,
  onDecide,
}: { request: ToolApprovalRequest } & Omit<RequestProps, "request"> & { onBack: () => void }) {
  const [view, setView] = useState<"formatted" | "json">("formatted");
  const params = Object.entries(request.tool.params);
  const raw = Object.entries(request.tool.raw);
  const paramSummary = toolParamSummary(request);

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-4 sm:p-8">
      <Button variant="ghost" size="sm" className="self-start" onClick={onBack}>
        ← All approvals
      </Button>

      <DetailHero request={request} now={now} title="Approve this tool call" />

      <Card aria-label="Tool call">
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="min-w-0">
            <code className="font-mono text-base break-all">{request.tool.name}</code>
          </CardTitle>
          <div className="flex shrink-0 gap-1">
            <Button
              variant={view === "formatted" ? "default" : "outline"}
              size="sm"
              aria-pressed={view === "formatted"}
              onClick={() => setView("formatted")}
            >
              Formatted
            </Button>
            <Button
              variant={view === "json" ? "default" : "outline"}
              size="sm"
              aria-pressed={view === "json"}
              onClick={() => setView("json")}
            >
              JSON
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {view === "formatted" ? (
            <section className="flex flex-col gap-4" aria-label="Tool call formatted view">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">capability: {request.tool.capability}</Badge>
                {paramSummary ? (
                  <span className="text-sm text-muted-foreground">{paramSummary}</span>
                ) : null}
              </div>
              <ToolKeyValues title="Canonical parameters" entries={params} />
              <ToolKeyValues title="Raw tool input" entries={raw} />
            </section>
          ) : (
            <section aria-label="Tool call JSON view">
              <pre className="overflow-x-auto rounded-md border border-border bg-background p-3 text-xs">
                {JSON.stringify(request.tool, null, 2)}
              </pre>
            </section>
          )}
        </CardContent>
      </Card>

      <ContextCard request={request} />

      <DecisionBar request={request} onDecide={onDecide} />
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

function ApprovalDetail({ request, now, onBack, onDecide }: RequestProps & { onBack: () => void }) {
  if (isToolRequest(request)) {
    return <ToolDetail request={request} now={now} onBack={onBack} onDecide={onDecide} />;
  }
  return <ShellDetail request={request} now={now} onBack={onBack} onDecide={onDecide} />;
}

function App() {
  const api = useMemo(() => createApprovalApi(), []);
  const [requests, setRequests] = useState<ApprovalRequest[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let active = true;
    async function refresh() {
      try {
        const next = await api.listRequests();
        if (!active) return;
        setRequests(next);
        setError(null);
      } catch (caught) {
        /* v8 ignore next 2 -- defensive fetch error rendering is covered through API tests. */
        if (active) setError(caught instanceof Error ? caught.message : "Unknown error");
      }
    }
    void refresh();
    const poll = window.setInterval(refresh, 2_000);
    const tick = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      active = false;
      window.clearInterval(poll);
      window.clearInterval(tick);
    };
  }, [api]);

  const selected = useMemo(
    () => requests.find((request) => request.id === selectedId) ?? null,
    [requests, selectedId],
  );

  async function decide(id: string, verdict: Verdict) {
    await api.decide({
      requestId: id,
      verdict,
      reason: `${verdict}ed in allowlister-remote`,
    });
    setRequests((current) => current.filter((request) => request.id !== id));
    setSelectedId((current) => (current === id ? null : current));
  }

  if (selected) {
    return (
      <ApprovalDetail
        request={selected}
        now={now}
        onBack={() => setSelectedId(null)}
        onDecide={decide}
      />
    );
  }

  if (requests.length === 0) {
    return (
      <main className="mx-auto flex max-w-3xl flex-col gap-3 p-8">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          allowlister remote
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">No pending approvals</h1>
        <p className="text-muted-foreground">
          Install this PWA on your desktop or phone and keep it ready for the next agent request.
        </p>
        {error ? (
          <p className="text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-4 sm:p-8">
      <header className="flex flex-col gap-1">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          allowlister remote
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Approvals inbox</h1>
        <p className="text-sm text-muted-foreground">
          {requests.length} pending {requests.length === 1 ? "approval" : "approvals"} · tap a card
          to expand
        </p>
        {error ? (
          <p className="text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </header>

      <ul className="flex flex-col gap-3" aria-label="Pending approvals">
        {requests.map((request) => (
          <InboxItem
            key={request.id}
            request={request}
            now={now}
            onOpen={setSelectedId}
            onDecide={decide}
          />
        ))}
      </ul>
    </main>
  );
}

export default App;
