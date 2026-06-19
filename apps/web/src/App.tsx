import { useEffect, useMemo, useState } from "react";
import { createApprovalApi } from "./api";
import { importantCommands, remainingDisplay, riskSignals } from "./approval";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import type { ApprovalRequest } from "./types";

type Verdict = "allow" | "deny";

interface RequestProps {
  request: ApprovalRequest;
  now: number;
  onDecide: (id: string, verdict: Verdict) => void;
}

function RiskBadges({ risks }: { risks: string[] }) {
  if (risks.length === 0) {
    return <Badge variant="outline">No high-risk signal detected</Badge>;
  }
  return (
    <>
      {risks.map((risk) => (
        <Badge variant="destructive" key={risk}>
          {risk}
        </Badge>
      ))}
    </>
  );
}

function InboxItem({
  request,
  now,
  onOpen,
  onDecide,
}: RequestProps & { onOpen: (id: string) => void }) {
  const commands = importantCommands(request);
  const headline = commands[0];
  const risks = riskSignals(request);
  const remaining = remainingDisplay(request, now);

  return (
    <li>
      <Card className="flex flex-col gap-4 p-4 sm:flex-row sm:items-stretch sm:justify-between">
        <button
          type="button"
          className="flex flex-1 flex-col items-start gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Open approval for ${headline}`}
          onClick={() => onOpen(request.id)}
        >
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {request.harness} · allowlister {request.currentVerdict}
          </span>
          <code className="font-mono text-base text-foreground">{headline}</code>
          {commands.length > 1 ? (
            <span className="text-xs text-muted-foreground">
              +{commands.length - 1} more command(s)
            </span>
          ) : null}
          <span className="text-sm text-muted-foreground">{request.currentReason}</span>
          <span className="flex flex-wrap gap-1.5">
            <RiskBadges risks={risks} />
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

function ApprovalDetail({ request, now, onBack, onDecide }: RequestProps & { onBack: () => void }) {
  const commands = importantCommands(request);
  const risks = riskSignals(request);
  const remaining = remainingDisplay(request, now);

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-4 sm:p-8">
      <Button variant="ghost" size="sm" className="self-start" onClick={onBack}>
        ← All approvals
      </Button>

      <section
        className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"
        aria-labelledby="approval-title"
      >
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {request.harness} · allowlister {request.currentVerdict}
          </p>
          <h1 id="approval-title" className="text-2xl font-semibold tracking-tight">
            Approve the action, not the wall of shell
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

      <Card aria-label="Important commands">
        <CardContent className="flex flex-col gap-2 p-4">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Needs your attention
          </span>
          {commands.map((command) => (
            <code className="font-mono text-base text-foreground" key={command}>
              {command}
            </code>
          ))}
        </CardContent>
      </Card>

      <section className="flex flex-wrap gap-1.5" aria-label="Risk signals">
        <RiskBadges risks={risks} />
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Parsed allowlister fragments</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-3">
              {request.fragments.map((fragment) => (
                <li className="flex flex-col gap-1" key={`${fragment.role}-${fragment.display}`}>
                  <code className="font-mono text-sm text-foreground">{fragment.display}</code>
                  <span className="text-xs text-muted-foreground">{fragment.verdict}</span>
                  {fragment.rule ? (
                    <small className="text-xs text-muted-foreground">{fragment.rule}</small>
                  ) : null}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Context</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <dl className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                  Working directory
                </dt>
                <dd className="font-mono text-sm">{request.cwd}</dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                  Request id
                </dt>
                <dd className="font-mono text-sm">{request.id}</dd>
              </div>
            </dl>
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">Show full script</summary>
              <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-background p-3 text-xs">
                {request.command}
              </pre>
            </details>
          </CardContent>
        </Card>
      </div>

      <footer className="flex gap-3">
        <Button variant="outline" className="flex-1" onClick={() => onDecide(request.id, "deny")}>
          Deny
        </Button>
        <Button className="flex-1" onClick={() => onDecide(request.id, "allow")}>
          Allow once
        </Button>
      </footer>
    </main>
  );
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
