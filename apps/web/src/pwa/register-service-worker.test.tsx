import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RegisterServiceWorker } from "./register-service-worker";

describe("RegisterServiceWorker", () => {
  const original = navigator.serviceWorker;

  afterEach(() => {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: original,
    });
  });

  it("registers the service worker when the browser supports it", async () => {
    const register = vi.fn().mockResolvedValue({ scope: "/" });
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register },
    });

    render(<RegisterServiceWorker />);
    // The effect registers on the next tick.
    await vi.waitFor(() => expect(register).toHaveBeenCalledWith("/sw.js"));
  });

  it("no-ops when service workers are unavailable", () => {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: undefined,
    });

    const { container } = render(<RegisterServiceWorker />);
    expect(container).toBeEmptyDOMElement();
  });

  it("swallows registration failures so the app still boots", async () => {
    const register = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register },
    });

    // Rendering must not throw even when registration rejects.
    expect(() => render(<RegisterServiceWorker />)).not.toThrow();
    await vi.waitFor(() => expect(register).toHaveBeenCalled());
  });
});
