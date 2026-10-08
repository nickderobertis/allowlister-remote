import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { normalizeBrokerRequest } from "./approval-normalize";
import { connectBroker } from "./pwa/broker-bridge";

// The web app's drift gate against the protocol-v3 wire contract. Its one
// authoritative source is the `allowlister-remote-protocol` crate, whose committed
// fixture pins every envelope's wire form; the Rust binaries build their frames
// through that crate. The web app restates the PWA-facing envelopes and the
// request payload in TypeScript (`broker-bridge.ts`, `approval-normalize.ts`) and
// plain JS (`public/sw.js`), so this drives each restatement with the fixture's
// frames and reports every place it disagrees. Vitest runs with apps/web as cwd.
const FIXTURE_PATH = resolve(
  process.cwd(),
  "../../crates/allowlister-remote-protocol/wire/protocol-v3.json",
);
const swSource = readFileSync(resolve(process.cwd(), "public/sw.js"), "utf8");

type Frame = Record<string, unknown>;
type WireFixture = { requestId: string; payload: Frame; frames: Record<string, Frame> };

// Narrow a fixture value to a JSON object at runtime rather than asserting it.
const asFrame = (value: unknown): Frame | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;

// Parse the fixture and check its shape before any check trusts it.
function loadFixture(): WireFixture {
  const parsed: unknown = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  const doc = asFrame(parsed);
  const payload = asFrame(doc?.payload);
  const rawFrames = asFrame(doc?.frames);
  if (typeof doc?.requestId !== "string" || !payload || !rawFrames) {
    throw new Error(`${FIXTURE_PATH}: expected { requestId, payload, frames }`);
  }
  const frames: Record<string, Frame> = {};
  for (const [name, value] of Object.entries(rawFrames)) {
    const frame = asFrame(value);
    if (!frame) throw new Error(`${FIXTURE_PATH}: frame ${name} is not an object`);
    frames[name] = frame;
  }
  return { requestId: doc.requestId, payload, frames };
}

// How each wire payload field lands on the rendered ApprovalRequest. Every field
// the fixture's payload carries must be listed, so a new wire field fails here
// until the app reads it.
const PAYLOAD_TO_REQUEST: Record<string, (request: Frame) => unknown> = {
  protocol_version: (r) => r.protocolVersion,
  subject: (r) => r.subject,
  harness: (r) => r.harness,
  session_id: (r) => r.sessionId,
  cwd: (r) => r.cwd,
  current_verdict: (r) => r.currentVerdict,
  current_reason: (r) => r.currentReason,
  command: (r) => r.command,
  fragments: (r) => r.fragments,
};

const same = (a: unknown, b: unknown) => isDeepStrictEqual(a, b);

function normalizerDrift(fixture: WireFixture): string[] {
  const drift: string[] = [];
  const request = asFrame(fixture.frames["broker_to_pwa.added"]?.request);
  if (!request) return ["broker_to_pwa.added: no request"];
  const normalized: Frame = { ...normalizeBrokerRequest(request) };
  if (normalized.id !== request.id) drift.push(`request.id: ${String(normalized.id)}`);
  for (const [field, value] of Object.entries(fixture.payload)) {
    const read = PAYLOAD_TO_REQUEST[field];
    if (!read) {
      drift.push(`payload.${field}: not read by the web app`);
    } else if (!same(read(normalized), value)) {
      drift.push(`payload.${field}: normalized to ${JSON.stringify(read(normalized))}`);
    }
  }
  return drift;
}

function bridgeDrift(fixture: WireFixture): { drift: string[]; posted: unknown[] } {
  const drift: string[] = [];
  const posted: unknown[] = [];
  let listener: ((event: MessageEvent) => void) | undefined;
  // connectBroker touches only these three members of the container, so this
  // partial stands in for the browser's ServiceWorkerContainer.
  const container = {
    controller: { postMessage: (message: unknown) => posted.push(message) },
    addEventListener: (_type: string, handler: (event: MessageEvent) => void) => {
      listener = handler;
    },
    removeEventListener: () => {},
  } as unknown as ServiceWorkerContainer;
  const seen: Record<string, unknown> = {};
  const bridge = connectBroker(
    "ws://broker",
    {
      onSnapshot: (requests) => {
        seen.snapshot = requests;
      },
      onAdded: (request) => {
        seen.added = request;
      },
      onResolved: (requestId) => {
        seen.resolved = requestId;
      },
    },
    container,
  );
  const frames = fixture.frames;
  for (const name of ["broker_to_pwa.snapshot", "broker_to_pwa.added", "broker_to_pwa.resolved"]) {
    listener?.(
      new MessageEvent("message", { data: { type: "broker-event", event: frames[name] } }),
    );
  }
  const expectations: [string, unknown, unknown][] = [
    ["broker_to_pwa.snapshot", seen.snapshot, fixture.frames["broker_to_pwa.snapshot"]?.requests],
    ["broker_to_pwa.added", seen.added, fixture.frames["broker_to_pwa.added"]?.request],
    ["broker_to_pwa.resolved", seen.resolved, fixture.requestId],
  ];
  for (const [name, got, want] of expectations) {
    if (got === undefined || !same(got, want))
      drift.push(`${name}: bridge read ${JSON.stringify(got)}`);
  }
  bridge.decide({
    requestId: fixture.requestId,
    verdict: "allow",
    reason: "approved from the web",
  });
  return { drift, posted };
}

type SwListener = (event: { data?: unknown }) => void;

async function serviceWorkerDrift(
  fixture: WireFixture,
  pageMessages: unknown[],
): Promise<string[]> {
  const drift: string[] = [];
  const listeners: Record<string, SwListener> = {};
  const relayed: unknown[] = [];
  const notifications: { data?: { requestId?: string } }[] = [];
  const closedTags: unknown[] = [];
  const sockets: { sent: string[]; emit: (type: string, event: { data?: string }) => void }[] = [];
  class WireSocket {
    readyState = 0;
    sent: string[] = [];
    private handlers: Record<string, ((event: { data?: string }) => void)[]> = {};
    constructor() {
      sockets.push(this);
    }
    addEventListener(type: string, handler: (event: { data?: string }) => void) {
      this.handlers[type] = [...(this.handlers[type] ?? []), handler];
    }
    send(data: string) {
      this.sent.push(data);
    }
    close() {}
    emit(type: string, event: { data?: string }) {
      if (type === "open") this.readyState = 1;
      for (const handler of this.handlers[type] ?? []) handler(event);
    }
  }
  const self = {
    addEventListener: (type: string, handler: SwListener) => {
      listeners[type] = handler;
    },
    clients: {
      matchAll: async () => [{ postMessage: (message: unknown) => relayed.push(message) }],
    },
    registration: {
      showNotification: async (_title: string, options: { data?: { requestId?: string } }) => {
        notifications.push(options);
      },
      getNotifications: async ({ tag }: { tag?: string } = {}) => {
        closedTags.push(tag);
        return [];
      },
    },
  };
  vm.runInNewContext(swSource, { self, WebSocket: WireSocket, setTimeout: () => 0, console });

  listeners.message?.({ data: { type: "broker-connect", url: "ws://broker" } });
  const socket = sockets[0];
  if (!socket) return ["service worker opened no socket"];
  socket.emit("open", {});
  const frames = fixture.frames;
  const firstSent = socket.sent[0] === undefined ? undefined : JSON.parse(socket.sent[0]);
  if (!same(firstSent, frames["pwa_to_broker.subscribe"])) {
    drift.push(`pwa_to_broker.subscribe: worker sent ${socket.sent[0]}`);
  }
  // The page's decision (posted by the bridge) is what the worker puts on the wire.
  for (const message of pageMessages) listeners.message?.({ data: message });
  const decision = socket.sent.find((text) => JSON.parse(text).type === "decision");
  if (!decision || !same(JSON.parse(decision), frames["pwa_to_broker.decision"])) {
    drift.push(`pwa_to_broker.decision: worker sent ${decision}`);
  }
  const inbound = ["broker_to_pwa.snapshot", "broker_to_pwa.added", "broker_to_pwa.resolved"];
  for (const name of inbound) socket.emit("message", { data: JSON.stringify(frames[name]) });
  // Let the worker's async client relay and notification calls settle.
  await new Promise((done) => setTimeout(done, 0));
  for (const name of inbound) {
    // The worker's objects come from the vm realm; compare them as JSON.
    const expected = { type: "broker-event", event: frames[name] };
    if (!relayed.some((message) => same(JSON.parse(JSON.stringify(message)), expected))) {
      drift.push(`${name}: worker did not relay the frame verbatim`);
    }
  }
  if (!notifications.some((n) => n.data?.requestId === fixture.requestId)) {
    drift.push("broker_to_pwa.added: worker raised no notification for the request id");
  }
  if (!closedTags.includes(fixture.requestId)) {
    drift.push("broker_to_pwa.resolved: worker did not close the request's notification");
  }
  return drift;
}

async function webDrift(fixture: WireFixture): Promise<string[]> {
  const { drift, posted } = bridgeDrift(fixture);
  const worker = await serviceWorkerDrift(fixture, posted);
  return [...normalizerDrift(fixture), ...drift, ...worker];
}

describe("protocol-v3 wire contract (web restatements)", () => {
  it("the bridge, normalizer and service worker agree with every PWA-facing fixture frame", async () => {
    expect(await webDrift(loadFixture())).toEqual([]);
  });

  it("reports a divergent copy: a renamed envelope field and payload field", async () => {
    const divergent = loadFixture();
    const rename = (frame: Frame | undefined, from: string, to: string) => {
      if (!frame) return;
      frame[to] = frame[from];
      delete frame[from];
    };
    rename(divergent.frames["broker_to_pwa.resolved"], "requestId", "request_id");
    rename(divergent.frames["pwa_to_broker.decision"], "requestId", "request_id");
    rename(divergent.payload, "session_id", "harness_session");
    const added = divergent.frames["broker_to_pwa.added"];
    const addedRequest = asFrame(added?.request);
    rename(addedRequest, "session_id", "harness_session");
    if (added) added.request = addedRequest;

    const drift = await webDrift(divergent);
    expect(drift).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^payload\.harness_session: not read/),
        expect.stringMatching(/^broker_to_pwa\.resolved:/),
        expect.stringMatching(/^pwa_to_broker\.decision:/),
      ]),
    );
  });
});
