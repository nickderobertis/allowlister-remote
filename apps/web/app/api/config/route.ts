import { NextResponse } from "next/server";

// Runtime configuration handed to the browser. The broker URL is read from the
// server environment on every request (not inlined at build time), so a single
// build can be pointed at different brokers per deployment and toggled on in
// e2e without rebuilding. Returns the `/ws/pwa` endpoint the service worker
// connects to, or null when no broker is configured (the app then relies on the
// HTTP polling fallback).
export function GET() {
  const base = process.env.ALLOWLISTER_REMOTE_BROKER_URL;
  const brokerUrl = base ? `${base.replace(/\/+$/, "")}/ws/pwa` : null;
  return NextResponse.json({ brokerUrl });
}
