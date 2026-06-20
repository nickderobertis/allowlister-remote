// Page-side bridge to the Rust broker, mediated by the service worker. The
// worker owns the single WebSocket (one per browser, shared across tabs); the
// page asks it to connect, listens for the broker events it relays via
// postMessage, and sends decisions back through it. Falls back gracefully (a
// no-op handle) when there is no service worker, so the caller can keep using
// HTTP polling.

type BrokerEventHandlers = {
  onSnapshot?: (requests: unknown[]) => void;
  onAdded?: (request: unknown) => void;
  onResolved?: (requestId: string) => void;
  onStatus?: (status: string) => void;
};

type BrokerDecision = {
  requestId: string;
  verdict: "allow" | "deny";
  reason: string;
};

interface BrokerBridge {
  decide: (decision: BrokerDecision) => void;
  close: () => void;
}

/**
 * Connect the page to the broker through the service worker. Returns a handle to
 * send decisions and to detach the listener. No-ops when there is no controlling
 * service worker.
 */
export function connectBroker(
  url: string,
  handlers: BrokerEventHandlers,
  container: ServiceWorkerContainer | undefined = globalThis.navigator?.serviceWorker,
): BrokerBridge {
  const post = (message: unknown) => container?.controller?.postMessage(message);

  const listener = (event: MessageEvent) => {
    const data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "broker-status") {
      handlers.onStatus?.(data.status);
      return;
    }
    if (data.type !== "broker-event") return;
    const brokerEvent = data.event;
    switch (brokerEvent?.type) {
      case "snapshot":
        handlers.onSnapshot?.(brokerEvent.requests ?? []);
        break;
      case "added":
        handlers.onAdded?.(brokerEvent.request);
        break;
      case "resolved":
        handlers.onResolved?.(brokerEvent.requestId);
        break;
    }
  };

  container?.addEventListener("message", listener);
  post({ type: "broker-connect", url });

  return {
    decide: (decision) => post({ type: "decision", ...decision }),
    close: () => container?.removeEventListener("message", listener),
  };
}
