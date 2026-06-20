import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createApprovalApi } from "./api";
import { normalizeBrokerRequest } from "./approval-normalize";
import { connectBroker } from "./pwa/broker-bridge";
import {
  flaggedFragments,
  remainingDisplay,
  requestHeadline,
  toolParamSummary,
  triggeredRules,
} from "./approval";
import { ThemeToggle } from "./components/theme-toggle";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { Kbd } from "./components/ui/kbd";
import { SHORTCUT_GROUPS, useIsDesktop, useKeyboardShortcuts } from "./lib/keyboard";
import { ThemeProvider } from "./lib/theme";
import { cn } from "./lib/utils";
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
  const remaining = remainingDisplay(request, now);
  const flaggedCount = request.subject === "shell" ? flaggedFragments(request).length : 0;
  const rules = request.subject === "shell" ? triggeredRules(request) : [];
  const itemRef = useRef<HTMLLIElement>(null);
  // The keyboard cursor: keep the focused card visible as J/K walk the list.
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
          className="flex flex-1 flex-col items-start gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Open approval for ${headline}`}
          aria-current={highlighted ? "true" : undefined}
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
              {highlighted ? <Kbd>D</Kbd> : null}
            </Button>
            <Button
              size="sm"
              aria-label={`Allow ${headline}`}
              onClick={() => onDecide(request.id, "allow")}
            >
              Allow
              {highlighted ? <Kbd>A</Kbd> : null}
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
        className="flex shrink-0 flex-col items-center rounded-lg border border-border bg-card px-4 py-3 shadow-sm"
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
        className="flex-1"
        aria-label="Deny"
        onClick={() => onDecide(request.id, "deny")}
      >
        Deny
        {showHints ? <Kbd>D</Kbd> : null}
      </Button>
      <Button
        className="flex-1"
        aria-label="Allow once"
        onClick={() => onDecide(request.id, "allow")}
      >
        Allow once
        {showHints ? <Kbd>A</Kbd> : null}
      </Button>
    </footer>
  );
}

function ShellDetail({
  request,
  now,
  showHints,
  keyboardEnabled,
  onBack,
  onDecide,
}: { request: ShellApprovalRequest } & Omit<RequestProps, "request"> &
  DetailChromeProps & { onBack: () => void }) {
  const flagged = flaggedFragments(request);
  // Leave the native <details> in charge of click toggling; the `S` shortcut
  // flips its open state through the ref so both paths stay in sync.
  const scriptRef = useRef<HTMLDetailsElement>(null);

  useKeyboardShortcuts(
    {
      s: () => {
        const details = scriptRef.current;
        if (details) details.open = !details.open;
      },
    },
    keyboardEnabled,
  );

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-4 sm:p-8">
      <BackButton showHints={showHints} onBack={onBack} />

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
          <details className="text-sm" ref={scriptRef}>
            <summary className="flex cursor-pointer items-center gap-2 text-muted-foreground">
              <span>Show full script</span>
              {showHints ? <Kbd>S</Kbd> : null}
            </summary>
            <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-background p-3 text-xs">
              {request.command}
            </pre>
          </details>
        </ContextCard>
      </div>

      <DecisionBar request={request} showHints={showHints} onDecide={onDecide} />
    </main>
  );
}

function ToolDetail({
  request,
  now,
  showHints,
  keyboardEnabled,
  onBack,
  onDecide,
}: { request: ToolApprovalRequest } & Omit<RequestProps, "request"> &
  DetailChromeProps & { onBack: () => void }) {
  const [view, setView] = useState<"formatted" | "json">("formatted");
  const params = Object.entries(request.tool.params);
  const raw = Object.entries(request.tool.raw);
  const paramSummary = toolParamSummary(request);

  useKeyboardShortcuts(
    { f: () => setView("formatted"), j: () => setView("json") },
    keyboardEnabled,
  );

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-4 sm:p-8">
      <BackButton showHints={showHints} onBack={onBack} />

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
  now,
  showHints,
  keyboardEnabled,
  onBack,
  onDecide,
}: RequestProps & DetailChromeProps & { onBack: () => void }) {
  // Allow / deny / back work the same for both subjects, so bind them once here;
  // each subject view binds its own extra keys (F/J for tools, S for shell).
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
        now={now}
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
      now={now}
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
      <Kbd>J</Kbd>
      <Kbd>K</Kbd>
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
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        allowlister remote
      </p>
      <h1 className="text-2xl font-semibold tracking-tight">No pending approvals</h1>
      <p className="text-muted-foreground">
        Install this PWA on your desktop or phone and keep it ready for the next agent request.
      </p>
      <ErrorBanner error={error} />
    </main>
  );
}

function InboxView({
  requests,
  now,
  focusedIndex,
  isDesktop,
  error,
  onOpen,
  onFocus,
  onDecide,
}: {
  requests: ApprovalRequest[];
  now: number;
  focusedIndex: number;
  isDesktop: boolean;
  error: string | null;
  onOpen: (id: string) => void;
  onFocus: (index: number) => void;
  onDecide: (id: string, verdict: Verdict) => void;
}) {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-4 sm:p-8">
      <header className="flex flex-col gap-1">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          allowlister remote
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Approvals inbox</h1>
        <p className="text-sm text-muted-foreground">
          {requests.length} pending {requests.length === 1 ? "approval" : "approvals"} ·{" "}
          {isDesktop ? "use the keyboard or tap a card" : "tap a card"} to expand
        </p>
        {isDesktop ? <InboxHints /> : null}
        <ErrorBanner error={error} />
      </header>

      <ul className="flex flex-col gap-3" aria-label="Pending approvals">
        {requests.map((request, index) => (
          <InboxItem
            key={request.id}
            request={request}
            now={now}
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
  const api = useMemo(() => createApprovalApi(), []);
  const [requests, setRequests] = useState<ApprovalRequest[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const isDesktop = useIsDesktop();
  // When the broker is live, decisions must travel back through it to the waiting
  // plugin (the request lives in the broker, not the Next store). Held in a ref so
  // `decide` can reach it without re-rendering on connect.
  const brokerRef = useRef<{
    decide: (decision: { requestId: string; verdict: "allow" | "deny"; reason: string }) => void;
    close: () => void;
  } | null>(null);

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

  // Realtime sync: when a broker is configured, the service worker holds one
  // WebSocket to it and relays live updates, so approvals appear and dismiss
  // instantly instead of waiting for the 2s poll above (which stays as the
  // fallback). The broker URL is fetched at runtime from /api/config. Requires a
  // service worker, so this is inert under jsdom and exercised via e2e.
  /* v8 ignore start -- realtime path runs against the broker; covered by e2e. */
  useEffect(() => {
    if (!navigator.serviceWorker) return;
    let cancelled = false;
    void fetch("/api/config")
      .then((response) => response.json())
      .then((config: { brokerUrl?: string | null }) => {
        if (cancelled || !config.brokerUrl) return;
        brokerRef.current = connectBroker(config.brokerUrl, {
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
          onResolved: (id) =>
            setRequests((current) => current.filter((request) => request.id !== id)),
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      brokerRef.current?.close();
      brokerRef.current = null;
    };
  }, []);
  /* v8 ignore stop */

  const selected = useMemo(
    () => requests.find((request) => request.id === selectedId) ?? null,
    [requests, selectedId],
  );

  // Keep the inbox cursor in range as requests resolve or new ones arrive.
  useEffect(() => {
    setFocusedIndex((index) => Math.min(index, Math.max(0, requests.length - 1)));
  }, [requests.length]);

  async function decide(id: string, verdict: Verdict) {
    const decision = { requestId: id, verdict, reason: `${verdict}ed in allowlister-remote` };
    // Route through the broker when it is live (the plugin is waiting there); the
    // HTTP call covers the polling path and is a harmless no-op otherwise.
    brokerRef.current?.decide(decision);
    await api.decide(decision);
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
      j: focusNext,
      ArrowDown: focusNext,
      k: focusPrev,
      ArrowUp: focusPrev,
      o: openFocused,
      Enter: openFocused,
      a: () => decideFocused("allow"),
      d: () => decideFocused("deny"),
    },
    inboxActive,
  );

  let content: ReactNode;
  if (selected) {
    content = (
      <ApprovalDetail
        request={selected}
        now={now}
        showHints={isDesktop}
        keyboardEnabled={isDesktop && !showShortcuts}
        onBack={() => setSelectedId(null)}
        onDecide={decide}
      />
    );
  } else if (requests.length === 0) {
    content = <EmptyInbox error={error} />;
  } else {
    content = (
      <InboxView
        requests={requests}
        now={now}
        focusedIndex={focusedIndex}
        isDesktop={isDesktop}
        error={error}
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
