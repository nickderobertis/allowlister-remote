// Page-side bridge to the Rust broker, mediated by the service worker. The
// worker owns the single WebSocket (one per browser, shared across tabs); the
// page asks it to connect, listens for the broker events it relays via
// postMessage, and sends decisions back through it. The broker is the only
// transport for approval requests; when there is no controlling service worker
// this returns an inert handle and the caller surfaces that as an error (there
// is no HTTP fallback).

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

  // On the very first load the page renders before the freshly-registered worker
  // has taken control, so `container.controller` is still null and the
  // `broker-connect` post below would be silently dropped — the UI would sit on
  // "Connecting to broker…" until a manual reload. The worker calls
  // `clients.claim()` on activate, which fires `controllerchange` on the page once
  // it controls it; defer the connect to that event when there is no controller
  // yet, so the first load connects on its own. It is one-shot (a later worker
  // update also fires `controllerchange`, and the worker already reconnects the
  // socket itself, so re-posting then would be redundant).
  const connect = () => post({ type: "broker-connect", url });
  let onControllerChange: (() => void) | undefined;
  if (container?.controller) {
    connect();
  } else if (container) {
    onControllerChange = () => {
      container.removeEventListener("controllerchange", onControllerChange as () => void);
      onControllerChange = undefined;
      connect();
    };
    container.addEventListener("controllerchange", onControllerChange);
  }

  return {
    decide: (decision) => post({ type: "decision", ...decision }),
    close: () => {
      container?.removeEventListener("message", listener);
      if (onControllerChange) {
        container?.removeEventListener("controllerchange", onControllerChange);
      }
    },
  };
}
