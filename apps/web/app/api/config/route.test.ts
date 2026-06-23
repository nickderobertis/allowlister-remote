import { afterEach, describe, expect, it } from "vitest";
import { GET } from "./route";

describe("runtime config route", () => {
  afterEach(() => {
    delete process.env.ALLOWLISTER_REMOTE_BROKER_URL;
  });

  it("derives the pwa websocket endpoint from the broker base url", async () => {
    process.env.ALLOWLISTER_REMOTE_BROKER_URL = "ws://broker:4180";
    expect(await GET().json()).toEqual({ brokerUrl: "ws://broker:4180/ws/pwa" });
  });

  it("tolerates a trailing slash on the base url", async () => {
    process.env.ALLOWLISTER_REMOTE_BROKER_URL = "ws://broker:4180/";
    expect(await GET().json()).toEqual({ brokerUrl: "ws://broker:4180/ws/pwa" });
  });

  it("fails with a 500 when no broker is configured", async () => {
    delete process.env.ALLOWLISTER_REMOTE_BROKER_URL;
    const response = GET();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "ALLOWLISTER_REMOTE_BROKER_URL is not configured",
    });
  });
});
