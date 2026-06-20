import { describe, expect, it, vi } from "vitest";
import { connectBroker } from "./broker-bridge";

/** A fake ServiceWorkerContainer that captures posts and lets a test emit
 * messages back as the service worker would. */
function fakeContainer(withController = true) {
  const posted: unknown[] = [];
  let handler: ((event: MessageEvent) => void) | undefined;
  const removeEventListener = vi.fn();
  const container = {
    controller: withController ? { postMessage: (m: unknown) => posted.push(m) } : null,
    addEventListener: (_type: string, h: (event: MessageEvent) => void) => {
      handler = h;
    },
    removeEventListener,
  } as unknown as ServiceWorkerContainer;
  const emit = (data: unknown) => handler?.({ data } as MessageEvent);
  return { container, posted, emit, removeEventListener };
}

describe("broker bridge", () => {
  it("asks the worker to connect to the broker url", () => {
    const { container, posted } = fakeContainer();
    connectBroker("ws://broker/ws/pwa", {}, container);
    expect(posted).toContainEqual({ type: "broker-connect", url: "ws://broker/ws/pwa" });
  });

  it("dispatches snapshot, added, and resolved events to handlers", () => {
    const { container, emit } = fakeContainer();
    const onSnapshot = vi.fn();
    const onAdded = vi.fn();
    const onResolved = vi.fn();
    connectBroker("ws://b", { onSnapshot, onAdded, onResolved }, container);

    emit({ type: "broker-event", event: { type: "snapshot", requests: [{ id: "r1" }] } });
    emit({ type: "broker-event", event: { type: "added", request: { id: "r2" } } });
    emit({ type: "broker-event", event: { type: "resolved", requestId: "r1" } });

    expect(onSnapshot).toHaveBeenCalledWith([{ id: "r1" }]);
    expect(onAdded).toHaveBeenCalledWith({ id: "r2" });
    expect(onResolved).toHaveBeenCalledWith("r1");
  });

  it("defaults a snapshot with no requests to an empty array", () => {
    const { container, emit } = fakeContainer();
    const onSnapshot = vi.fn();
    connectBroker("ws://b", { onSnapshot }, container);
    emit({ type: "broker-event", event: { type: "snapshot" } });
    expect(onSnapshot).toHaveBeenCalledWith([]);
  });

  it("reports connection status changes", () => {
    const { container, emit } = fakeContainer();
    const onStatus = vi.fn();
    connectBroker("ws://b", { onStatus }, container);
    emit({ type: "broker-status", status: "closed" });
    expect(onStatus).toHaveBeenCalledWith("closed");
  });

  it("sends a decision back through the worker", () => {
    const { container, posted } = fakeContainer();
    const bridge = connectBroker("ws://b", {}, container);
    bridge.decide({ requestId: "r1", verdict: "allow", reason: "ok" });
    expect(posted).toContainEqual({
      type: "decision",
      requestId: "r1",
      verdict: "allow",
      reason: "ok",
    });
  });

  it("detaches the listener on close", () => {
    const { container, removeEventListener } = fakeContainer();
    const bridge = connectBroker("ws://b", {}, container);
    bridge.close();
    expect(removeEventListener).toHaveBeenCalled();
  });

  it("ignores malformed and unknown messages", () => {
    const { container, emit } = fakeContainer();
    const onAdded = vi.fn();
    connectBroker("ws://b", { onAdded }, container);
    emit(null);
    emit({ type: "something-else" });
    emit({ type: "broker-event", event: { type: "unknown" } });
    emit({ type: "broker-event" }); // no event payload
    expect(onAdded).not.toHaveBeenCalled();
  });

  it("no-ops without a controlling service worker", () => {
    const { container, posted } = fakeContainer(false);
    const bridge = connectBroker("ws://b", {}, container);
    bridge.decide({ requestId: "r1", verdict: "deny", reason: "no" });
    expect(posted).toHaveLength(0); // nothing posted; no throw
    bridge.close();
  });

  it("falls back to the navigator service worker when no container is given", () => {
    // jsdom's navigator has no serviceWorker, so the default resolves to
    // undefined and the bridge is a safe no-op rather than throwing.
    expect(() => connectBroker("ws://b", {})).not.toThrow();
  });
});
