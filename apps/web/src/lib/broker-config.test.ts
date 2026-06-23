import { afterEach, describe, expect, it } from "vitest";
import {
  BROKER_URL_STORAGE_KEY,
  brokerWsUrl,
  isValidBrokerBase,
  resolveBrokerBase,
  setStoredBrokerBase,
} from "./broker-config";

afterEach(() => {
  window.localStorage.clear();
});

describe("broker-config", () => {
  it("derives the /ws/pwa endpoint and trims trailing slashes", () => {
    expect(brokerWsUrl("wss://broker.example.com")).toBe("wss://broker.example.com/ws/pwa");
    expect(brokerWsUrl("wss://broker.example.com//")).toBe("wss://broker.example.com/ws/pwa");
  });

  it("prefers a ?broker= deep link and persists it for later loads", () => {
    expect(resolveBrokerBase("?broker=ws://from-query")).toBe("ws://from-query");
    // Persisted, so a subsequent load without the query keeps using it.
    expect(window.localStorage.getItem(BROKER_URL_STORAGE_KEY)).toBe("ws://from-query");
    expect(resolveBrokerBase("")).toBe("ws://from-query");
  });

  it("falls back to the saved setting, then to nothing", () => {
    expect(resolveBrokerBase("")).toBeNull();
    setStoredBrokerBase("ws://saved");
    expect(resolveBrokerBase("")).toBe("ws://saved");
  });

  it("clears the saved setting when given an empty value", () => {
    setStoredBrokerBase("ws://saved");
    setStoredBrokerBase("");
    expect(window.localStorage.getItem(BROKER_URL_STORAGE_KEY)).toBeNull();
    expect(resolveBrokerBase("")).toBeNull();
  });

  it("accepts only well-formed ws:// and wss:// URLs", () => {
    expect(isValidBrokerBase("wss://broker.example.com")).toBe(true);
    expect(isValidBrokerBase("  ws://localhost:8787  ")).toBe(true);
    expect(isValidBrokerBase("")).toBe(false);
    expect(isValidBrokerBase("   ")).toBe(false);
    expect(isValidBrokerBase("https://broker.example.com")).toBe(false);
    expect(isValidBrokerBase("broker.example.com")).toBe(false);
    expect(isValidBrokerBase("not a url")).toBe(false);
  });
});
