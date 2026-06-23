import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { normalizeBrokerRequest } from "@/approval-normalize";
import { ApprovalDetail } from "@/components/approval/detail";
import { EmptyInbox, InboxView } from "@/components/approval/inbox";
import { ShortcutsHint, ShortcutsOverlay } from "@/components/approval/shortcuts";
import { BrokerSetup } from "@/components/broker-setup";
import type { BrokerStatus } from "@/components/connection-status";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { brokerWsUrl, resolveBrokerBase, setStoredBrokerBase } from "@/lib/broker-config";
import { useIsDesktop, useKeyboardShortcuts } from "@/lib/keyboard";
import { ThemeProvider } from "@/lib/theme";
import { connectBroker } from "@/pwa/broker-bridge";
import type { ApprovalRequest } from "@/types";

type Verdict = "allow" | "deny";
type BootState = "resolving" | "no-sw" | "needs-broker" | "ready";

// The single visible view, chosen from the boot/selection state. Kept as its own
// component so the orchestrator below stays focused on state and effects.
function MainView({
  bootState,
  settingUpBroker,
  reconfiguring,
  selected,
  requests,
  focusedIndex,
  isDesktop,
  showShortcuts,
  brokerStatus,
  brokerBase,
  onSaveBroker,
  onCancelReconfigure,
  onSelect,
  onClearSelection,
  onFocus,
  onDecide,
}: {
  bootState: BootState;
  settingUpBroker: boolean;
  reconfiguring: boolean;
  selected: ApprovalRequest | null;
  requests: ApprovalRequest[];
  focusedIndex: number;
  isDesktop: boolean;
  showShortcuts: boolean;
  brokerStatus: BrokerStatus;
  brokerBase: string | null;
  onSaveBroker: (base: string) => void;
  onCancelReconfigure: () => void;
  onSelect: (id: string) => void;
  onClearSelection: () => void;
  onFocus: (index: number) => void;
  onDecide: (id: string, verdict: Verdict) => void;
}): ReactNode {
  if (bootState === "no-sw") {
    return (
      <EmptyInbox error="This browser has no service worker, which allowlister-remote requires." />
    );
  }
  if (settingUpBroker) {
    return (
      <BrokerSetup
        onSave={onSaveBroker}
        initialValue={reconfiguring ? (brokerBase ?? "") : ""}
        {...(reconfiguring ? { onCancel: onCancelReconfigure } : {})}
      />
    );
  }
  if (selected) {
    return (
      <ApprovalDetail
        request={selected}
        showHints={isDesktop}
        keyboardEnabled={isDesktop && !showShortcuts}
        onBack={onClearSelection}
        onDecide={onDecide}
      />
    );
  }
  if (requests.length === 0) {
    return <EmptyInbox error={null} status={brokerStatus} />;
  }
  return (
    <InboxView
      requests={requests}
      focusedIndex={focusedIndex}
      isDesktop={isDesktop}
      status={brokerStatus}
      onOpen={onSelect}
      onFocus={onFocus}
      onDecide={onDecide}
    />
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
  const [bootState, setBootState] = useState<BootState>("resolving");
  // The live broker connection, surfaced so an unreachable broker is visible
  // rather than looking like an idle inbox. Starts "connecting" until the bridge
  // reports the socket opened or dropped.
  const [brokerStatus, setBrokerStatus] = useState<BrokerStatus>("connecting");
  // Whether the user is changing an already-configured broker (vs first-run).
  const [reconfiguring, setReconfiguring] = useState(false);
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
    setBrokerStatus("connecting");
    const bridge = connectBroker(brokerWsUrl(brokerBase), {
      onStatus: (status) => setBrokerStatus(status === "open" ? "online" : "offline"),
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

  // Persist a broker URL entered on the setup screen, then connect to it. Clears
  // any stale requests so a broker switch doesn't leave the old broker's cards.
  function saveBrokerBase(base: string) {
    setStoredBrokerBase(base);
    setRequests([]);
    setBrokerBase(base);
    setBootState("ready");
    setReconfiguring(false);
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

  // The broker-setup screen owns the keyboard while it is up, so the inbox/global
  // shortcuts pause to avoid stealing keys from its form.
  const settingUpBroker = bootState === "needs-broker" || reconfiguring;
  // Toggle the shortcuts panel from anywhere on desktop.
  useKeyboardShortcuts({ "?": togglePanel }, isDesktop && !settingUpBroker);
  // While the panel is open, Escape closes it and every other shortcut pauses.
  useKeyboardShortcuts({ Escape: closePanel }, isDesktop && showShortcuts);
  // Inbox navigation, only while a list is showing and nothing is layered on top.
  const inboxActive =
    isDesktop && !selected && !showShortcuts && !settingUpBroker && requests.length > 0;
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

  // The broker can be changed once configured; hide the control while the setup
  // screen itself is up (it has its own Cancel).
  const canChangeBroker = bootState === "ready" && !settingUpBroker;

  return (
    <ThemeProvider>
      <div className="fixed right-4 top-4 z-40 flex items-center gap-2">
        {canChangeBroker ? (
          <Button
            variant="outline"
            size="sm"
            aria-label="Change broker"
            onClick={() => setReconfiguring(true)}
          >
            Broker
          </Button>
        ) : null}
        <ThemeToggle />
      </div>
      <MainView
        bootState={bootState}
        settingUpBroker={settingUpBroker}
        reconfiguring={reconfiguring}
        selected={selected}
        requests={requests}
        focusedIndex={focusedIndex}
        isDesktop={isDesktop}
        showShortcuts={showShortcuts}
        brokerStatus={brokerStatus}
        brokerBase={brokerBase}
        onSaveBroker={saveBrokerBase}
        onCancelReconfigure={() => setReconfiguring(false)}
        onSelect={setSelectedId}
        onClearSelection={() => setSelectedId(null)}
        onFocus={setFocusedIndex}
        onDecide={decide}
      />
      {isDesktop && !showShortcuts && !settingUpBroker ? (
        <ShortcutsHint onOpen={() => setShowShortcuts(true)} />
      ) : null}
      {isDesktop && showShortcuts ? (
        <ShortcutsOverlay onClose={() => setShowShortcuts(false)} />
      ) : null}
    </ThemeProvider>
  );
}

export default App;
