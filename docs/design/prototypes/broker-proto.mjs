// Broker transport prototype — validates the server-side mechanics the real
// Next.js route handlers will use for the realtime-sync design (see
// ../realtime-sync.md). Plain Node built-ins only (http, events): the transport
// mechanics (long-poll hang+release, SSE push, Last-Event-ID replay, heartbeat)
// are runtime-agnostic, so validating them here de-risks the route handlers
// without standing up the full app.
//
//   node broker-proto.mjs          # run server + self-test driver, exit 0/1
//   node broker-proto.mjs serve    # run just the server on PORT (default 8787)
//
// What it proves:
//   1. A long-poll GET hangs while pending and is released ~immediately (one
//      RTT) when a decision is posted — near-zero delivery latency, no churn.
//   2. An SSE stream pushes a `decided` event to a connected browser.
//   3. A reconnecting SSE client replays missed events via Last-Event-ID, so
//      day-long sessions survive reconnects without losing a decision.
//   4. Heartbeat comments are emitted to keep idle connections alive.

import http from "node:http";
import { EventEmitter } from "node:events";

const HANG_MS = Number(process.env.HANG_MS ?? 2000); // long-poll deadline cap
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS ?? 200);

// ---- store: the in-memory model + a notification primitive ------------------
// This is the shape src/server/store.ts grows: the same maps plus an emitter
// and a monotonic event log so both transports (long-poll + SSE) observe the
// exact same state transitions.
function createStore() {
  const requests = new Map();
  const decisions = new Map();
  const log = []; // { seq, type, data } — replayable event history
  const bus = new EventEmitter();
  bus.setMaxListeners(0);
  let seq = 0;

  function emit(type, data) {
    const event = { seq: ++seq, type, data };
    log.push(event);
    bus.emit("event", event);
    return event;
  }

  return {
    bus,
    enqueue(req) {
      const id = req.id ?? `req-${seq + 1}`;
      const record = { ...req, id };
      requests.set(id, record);
      emit("added", record);
      return record;
    },
    decide(id, decision) {
      if (decisions.has(id)) return decisions.get(id); // first write wins
      const record = { requestId: id, ...decision };
      decisions.set(id, record);
      emit("decided", record);
      return record;
    },
    getDecision(id) {
      return decisions.get(id) ?? null;
    },
    eventsSince(lastSeq) {
      return log.filter((event) => event.seq > lastSeq);
    },
    // Resolve when this id is decided, or null at the deadline. This is the
    // waitForDecision() that replaces the plugin's 150ms poll loop.
    waitForDecision(id, deadlineMs) {
      const existing = decisions.get(id);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => {
        const onEvent = (event) => {
          if (event.type === "decided" && event.data.requestId === id) {
            cleanup();
            resolve(event.data);
          }
        };
        const timer = setTimeout(() => {
          cleanup();
          resolve(null);
        }, deadlineMs);
        const cleanup = () => {
          clearTimeout(timer);
          bus.off("event", onEvent);
        };
        bus.on("event", onEvent);
      });
    },
  };
}

// ---- server -----------------------------------------------------------------
function createServer(store) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");

    // Plugin opens a request.
    if (req.method === "POST" && url.pathname === "/api/plugin/requests") {
      const body = await readJson(req);
      const record = store.enqueue(body);
      return json(res, 200, { id: record.id });
    }

    // Plugin (via the daemon) long-polls for a decision: hangs until decided or
    // the deadline, then returns 200 + decision or 202 pending.
    const decisionMatch = url.pathname.match(/^\/api\/plugin\/requests\/([^/]+)\/decision$/);
    if (req.method === "GET" && decisionMatch) {
      const id = decisionMatch[1];
      const decision = await store.waitForDecision(id, HANG_MS);
      if (!decision) return json(res, 202, { status: "pending" });
      return json(res, 200, decision);
    }

    // Browser (or daemon) posts a decision — the single arbitration point.
    const postMatch = url.pathname.match(/^\/api\/approval-requests\/([^/]+)\/decision$/);
    if (req.method === "POST" && postMatch) {
      const body = await readJson(req);
      if (body.verdict !== "allow" && body.verdict !== "deny") {
        return json(res, 400, { error: "verdict must be allow or deny" });
      }
      store.decide(postMatch[1], { verdict: body.verdict, reason: body.reason ?? "" });
      return json(res, 200, { ok: true });
    }

    // SSE stream for the PWA (and the daemon's upstream): replay-then-live with
    // Last-Event-ID resume and heartbeats.
    if (req.method === "GET" && url.pathname === "/api/events") {
      const lastId = Number(req.headers["last-event-id"] ?? url.searchParams.get("lastEventId") ?? 0);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no", // defeat proxy buffering
      });
      for (const event of store.eventsSince(lastId)) writeEvent(res, event);
      const onEvent = (event) => writeEvent(res, event);
      store.bus.on("event", onEvent);
      const heartbeat = setInterval(() => res.write(":ping\n\n"), HEARTBEAT_MS);
      req.on("close", () => {
        clearInterval(heartbeat);
        store.bus.off("event", onEvent);
      });
      return;
    }

    json(res, 404, { error: "not found" });
  });
}

function writeEvent(res, event) {
  res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
}
function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
function readJson(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => resolve(raw ? JSON.parse(raw) : {}));
  });
}

// ---- tiny clients for the driver --------------------------------------------
function request(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { port, method, path, headers: { "Content-Type": "application/json" } },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
      },
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Minimal SSE client: collects parsed events and raw frames (to spot pings).
function openSse(port, { lastEventId } = {}) {
  const headers = {};
  if (lastEventId != null) headers["Last-Event-ID"] = String(lastEventId);
  const events = [];
  let raw = "";
  const handle = { events, sawHeartbeat: false, close: () => {} };
  const req = http.get({ port, path: "/api/events", headers }, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      raw += chunk;
      if (raw.includes(":ping")) handle.sawHeartbeat = true;
      let idx;
      while ((idx = raw.indexOf("\n\n")) !== -1) {
        const frame = raw.slice(0, idx);
        raw = raw.slice(idx + 2);
        if (frame.startsWith(":")) continue; // heartbeat comment
        const event = {};
        for (const line of frame.split("\n")) {
          const [key, ...rest] = line.split(":");
          const value = rest.join(":").trim();
          if (key === "id") event.seq = Number(value);
          else if (key === "event") event.type = value;
          else if (key === "data") event.data = JSON.parse(value);
        }
        if (event.type) events.push(event);
      }
    });
  });
  handle.close = () => req.destroy();
  return handle;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- self-test driver -------------------------------------------------------
async function drive(port) {
  const checks = [];
  const ok = (name, cond, detail = "") => {
    checks.push({ name, pass: !!cond, detail });
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  };

  // 1. Long-poll hangs while pending, releases ~instantly on decide.
  const { body: created } = await request(port, "POST", "/api/plugin/requests", {
    subject: "shell",
    command: "gh pr merge 42",
  });
  const id = created.id;

  const sse = openSse(port);
  await sleep(50); // let SSE connect & replay the 'added' event

  let pollResolved = false;
  const pollStart = Date.now();
  const pollPromise = request(port, "GET", `/api/plugin/requests/${id}/decision`).then((r) => {
    pollResolved = true;
    return r;
  });
  await sleep(150);
  ok("long-poll hangs while pending", pollResolved === false);

  const decisionAt = Date.now();
  await request(port, "POST", `/api/approval-requests/${id}/decision`, {
    verdict: "allow",
    reason: "approved in web app",
  });
  const pollResult = await pollPromise;
  const latency = Date.now() - decisionAt;
  ok("long-poll released with the decision", pollResult.body.verdict === "allow");
  ok("delivery latency is ~one RTT", latency < HANG_MS / 2, `${latency}ms`);
  ok("delivery faster than the old 150ms poll", latency < 150, `${latency}ms`);

  // 2. SSE pushed the decided event to the connected browser.
  await sleep(50);
  const decided = sse.events.find((e) => e.type === "decided" && e.data.requestId === id);
  ok("SSE pushed the decided event", !!decided);
  const decidedSeq = decided?.seq;

  // 3. Reconnect with Last-Event-ID replays the missed decided event.
  sse.close();
  const resumed = openSse(port, { lastEventId: decidedSeq - 1 });
  await sleep(100);
  const replayed = resumed.events.find((e) => e.seq === decidedSeq && e.type === "decided");
  ok("Last-Event-ID reconnect replays the missed event", !!replayed);

  // 4. Heartbeats keep the idle connection alive.
  await sleep(HEARTBEAT_MS + 100);
  ok("SSE emits heartbeats", resumed.sawHeartbeat);
  resumed.close();

  const passed = checks.every((c) => c.pass);
  console.log(`\n${passed ? "ALL PASS" : "FAILURES"} — ${checks.filter((c) => c.pass).length}/${checks.length}`);
  return passed;
}

// ---- entry ------------------------------------------------------------------
const store = createStore();
const server = createServer(store);

if (process.argv[2] === "serve") {
  const port = Number(process.env.PORT ?? 8787);
  server.listen(port, () => console.log(`broker prototype on http://127.0.0.1:${port}`));
} else {
  server.listen(0, async () => {
    const port = server.address().port;
    let passed = false;
    try {
      passed = await drive(port);
    } catch (error) {
      console.error("driver error:", error);
    } finally {
      server.close();
      process.exit(passed ? 0 : 1);
    }
  });
}
