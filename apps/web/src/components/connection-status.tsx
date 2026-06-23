import { cn } from "@/lib/utils";

// The live state of the single WebSocket the service worker holds to the broker.
// "connecting" is the resting state before the first frame arrives; the broker
// bridge then reports "online" (socket open) or "offline" (socket dropped, a
// reconnect is in flight). Surfaced so an unreachable or mistyped broker is
// visibly distinct from a connected-but-idle inbox.
export type BrokerStatus = "connecting" | "online" | "offline";

const STATUS_LABEL: Record<BrokerStatus, string> = {
  connecting: "Connecting to broker…",
  online: "Connected to broker",
  offline: "Reconnecting to broker…",
};

const STATUS_DOT: Record<BrokerStatus, string> = {
  connecting: "bg-muted-foreground",
  online: "bg-emerald-500",
  offline: "bg-amber-500",
};

// A compact dot-plus-label indicator. `aria-live="polite"` announces transitions
// (e.g. a drop) without stealing focus, so the status is conveyed non-visually too.
export function ConnectionStatus({ status }: { status: BrokerStatus }) {
  return (
    <p
      className="flex items-center gap-2 text-xs text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      <span className={cn("h-2 w-2 rounded-full", STATUS_DOT[status])} aria-hidden="true" />
      {STATUS_LABEL[status]}
    </p>
  );
}
