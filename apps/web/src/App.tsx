import { useEffect, useMemo, useState } from "react";
import { createApprovalApi } from "./api";
import { importantCommands, riskSignals, secondsRemaining } from "./approval";
import type { ApprovalRequest } from "./types";
import "./App.css";

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
        setSelectedId((current) => current ?? next[0]?.id ?? null);
        setError(null);
      } catch (caught) {
        /* v8 ignore next 2 -- defensive fetch error rendering is covered through API tests. */
        if (active)
          setError(caught instanceof Error ? caught.message : "Unknown error");
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
    () => requests.find((request) => request.id === selectedId) ?? requests[0],
    [requests, selectedId],
  );

  async function decide(verdict: "allow" | "deny") {
    /* v8 ignore next -- buttons are only rendered when a request is selected. */
    if (!selected) return;
    await api.decide({
      requestId: selected.id,
      verdict,
      reason: `${verdict}ed in allowlister-remote`,
    });
    setRequests((current) =>
      current.filter((request) => request.id !== selected.id),
    );
    setSelectedId(null);
  }

  if (!selected) {
    return (
      <main className="shell empty-state">
        <p className="eyebrow">allowlister remote</p>
        <h1>No pending approvals</h1>
        <p>
          Install this PWA on your desktop or phone and keep it ready for the
          next agent request.
        </p>
        {error ? <p role="alert">{error}</p> : null}
      </main>
    );
  }

  const commands = importantCommands(selected);
  const risks = riskSignals(selected);

  return (
    <main className="shell">
      <section className="hero" aria-labelledby="approval-title">
        <div>
          <p className="eyebrow">
            {selected.harness} · allowlister {selected.currentVerdict}
          </p>
          <h1 id="approval-title">Approve the action, not the wall of shell</h1>
          <p className="reason">{selected.currentReason}</p>
        </div>
        <div
          className="timer"
          aria-label={`${secondsRemaining(selected, now)} seconds remaining`}
        >
          <span>{secondsRemaining(selected, now)}</span>
          <small>sec</small>
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
            {selected.fragments.map((fragment) => (
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
              <dd>{selected.cwd}</dd>
            </div>
            <div>
              <dt>Request id</dt>
              <dd>{selected.id}</dd>
            </div>
          </dl>
          <details>
            <summary>Show full script</summary>
            <pre>{selected.command}</pre>
          </details>
        </article>
      </section>

      <nav className="request-rail" aria-label="Pending approvals">
        {requests.map((request) => (
          <button
            className={request.id === selected.id ? "active" : ""}
            key={request.id}
            onClick={() => setSelectedId(request.id)}
            type="button"
          >
            {importantCommands(request)[0]}
          </button>
        ))}
      </nav>

      <footer className="decision-bar">
        <button
          className="deny"
          onClick={() => void decide("deny")}
          type="button"
        >
          Deny
        </button>
        <button
          className="allow"
          onClick={() => void decide("allow")}
          type="button"
        >
          Allow once
        </button>
      </footer>
    </main>
  );
}

export default App;
