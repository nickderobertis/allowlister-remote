import { NextResponse } from "next/server";

// Runtime configuration handed to the browser. The broker URL is read from the
// server environment on every request (not inlined at build time), so a single
// build can be pointed at different brokers per deployment and toggled on in
// e2e without rebuilding. Returns the `/ws/pwa` endpoint the service worker
// connects to. The broker is mandatory — it is the only path requests reach the
// app — so a missing `ALLOWLISTER_REMOTE_BROKER_URL` is a deployment error
// (HTTP 500) rather than a silent fallback.
export function GET() {
  const base = process.env.ALLOWLISTER_REMOTE_BROKER_URL;
  if (!base) {
    return NextResponse.json(
      { error: "ALLOWLISTER_REMOTE_BROKER_URL is not configured" },
      { status: 500 },
    );
  }
  const brokerUrl = `${base.replace(/\/+$/, "")}/ws/pwa`;
  return NextResponse.json({ brokerUrl });
}
