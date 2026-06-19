import { useEffect, useMemo, useState } from "react";
import { createApprovalApi } from "./api";
import { importantCommands, remainingDisplay, riskSignals } from "./approval";
import type { ApprovalRequest } from "./types";
import "./App.css";

type Verdict = "allow" | "deny";

interface RequestProps {
  request: ApprovalRequest;
  now: number;
  onDecide: (id: string, verdict: Verdict) => void;
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
    <li className="inbox-item">
      <button
        className="inbox-open"
        type="button"
        aria-label={`Open approval for ${headline}`}
        onClick={() => onOpen(request.id)}
      >
        <span className="inbox-eyebrow">
          {request.harness} · allowlister {request.currentVerdict}
        </span>
        <code className="inbox-command">{headline}</code>
        {commands.length > 1 ? (
          <span className="inbox-more">+{commands.length - 1} more command(s)</span>
        ) : null}
        <span className="inbox-reason">{request.currentReason}</span>
        <span className="inbox-risks">
          {risks.length === 0 ? (
            <span className="safe-chip">No high-risk signal detected</span>
          ) : (
            risks.map((risk) => (
              <span className="risk-chip" key={risk}>
                {risk}
              </span>
            ))
          )}
        </span>
      </button>

      <div className="inbox-side">
        <span
          className="inbox-timer"
          role="timer"
          aria-label={`${remaining.label} for ${headline}`}
        >
          {remaining.compact}
        </span>
        <div className="inbox-actions">
          <button
            className="deny"
            type="button"
            aria-label={`Deny ${headline}`}
            onClick={() => onDecide(request.id, "deny")}
          >
            Deny
          </button>
          <button
            className="allow"
            type="button"
            aria-label={`Allow ${headline}`}
            onClick={() => onDecide(request.id, "allow")}
          >
            Allow
          </button>
        </div>
      </div>
    </li>
  );
}

function ApprovalDetail({ request, now, onBack, onDecide }: RequestProps & { onBack: () => void }) {
  const commands = importantCommands(request);
  const risks = riskSignals(request);
  const remaining = remainingDisplay(request, now);

  return (
    <main className="shell detail">
      <button className="back-button" type="button" onClick={onBack}>
        ← All approvals
      </button>

      <section className="hero" aria-labelledby="approval-title">
        <div>
          <p className="eyebrow">
            {request.harness} · allowlister {request.currentVerdict}
          </p>
          <h1 id="approval-title">Approve the action, not the wall of shell</h1>
          <p className="reason">{request.currentReason}</p>
        </div>
        <div className="timer" role="timer" aria-label={remaining.label}>
          <span>{remaining.value}</span>
          <small>{remaining.unit}</small>
        </div>
      </section>

      <section className="command-card" aria-label="Important commands">
        <span className="card-label">Needs your attention</span>
        {commands.map((command) => (
          <code className="primary-command" key={command}>
            {command}
          </code>
        ))}
      </section>

      <section className="risk-grid" aria-label="Risk signals">
        {risks.length === 0 ? (
          <span className="safe-chip">No high-risk signal detected</span>
        ) : null}
        {risks.map((risk) => (
          <span className="risk-chip" key={risk}>
            {risk}
          </span>
        ))}
      </section>

      <section className="details-grid">
        <article>
          <h2>Parsed allowlister fragments</h2>
          <ul className="fragment-list">
            {request.fragments.map((fragment) => (
              <li key={`${fragment.role}-${fragment.display}`}>
                <code>{fragment.display}</code>
                <span>{fragment.verdict}</span>
                {fragment.rule ? <small>{fragment.rule}</small> : null}
              </li>
            ))}
          </ul>
        </article>
        <article>
          <h2>Context</h2>
          <dl>
            <div>
              <dt>Working directory</dt>
              <dd>{request.cwd}</dd>
            </div>
            <div>
              <dt>Request id</dt>
              <dd>{request.id}</dd>
            </div>
          </dl>
          <details>
            <summary>Show full script</summary>
            <pre>{request.command}</pre>
          </details>
        </article>
      </section>

      <footer className="decision-bar">
        <button className="deny" type="button" onClick={() => onDecide(request.id, "deny")}>
          Deny
        </button>
        <button className="allow" type="button" onClick={() => onDecide(request.id, "allow")}>
          Allow once
        </button>
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
      <main className="shell empty-state">
        <p className="eyebrow">allowlister remote</p>
        <h1>No pending approvals</h1>
        <p>
          Install this PWA on your desktop or phone and keep it ready for the next agent request.
        </p>
        {error ? <p role="alert">{error}</p> : null}
      </main>
    );
  }

  return (
    <main className="shell inbox">
      <header className="inbox-header">
        <p className="eyebrow">allowlister remote</p>
        <h1>Approvals inbox</h1>
        <p className="inbox-count">
          {requests.length} pending {requests.length === 1 ? "approval" : "approvals"} · tap a card
          to expand
        </p>
        {error ? <p role="alert">{error}</p> : null}
      </header>

      <ul className="inbox-list" aria-label="Pending approvals">
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
