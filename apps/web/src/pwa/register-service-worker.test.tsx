import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RegisterServiceWorker } from "./register-service-worker";

type NotificationStub = {
  permission: NotificationPermission;
  requestPermission: ReturnType<typeof vi.fn>;
};

function stubNotification(
  permission: NotificationPermission,
  result: Promise<NotificationPermission>,
) {
  const requestPermission = vi.fn(() => result);
  Object.defineProperty(globalThis, "Notification", {
    configurable: true,
    value: { permission, requestPermission } satisfies NotificationStub,
  });
  return requestPermission;
}

describe("RegisterServiceWorker", () => {
  const original = navigator.serviceWorker;
  const originalNotification = (globalThis as { Notification?: unknown }).Notification;

  afterEach(() => {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: original,
    });
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      value: originalNotification,
    });
  });

  it("requests notification permission once when it has not been answered", async () => {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register: vi.fn().mockResolvedValue({ scope: "/" }) },
    });
    const requestPermission = stubNotification("default", Promise.resolve("granted"));

    render(<RegisterServiceWorker />);
    await vi.waitFor(() => expect(requestPermission).toHaveBeenCalled());
  });

  it("does not re-ask once the user has answered", () => {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register: vi.fn().mockResolvedValue({ scope: "/" }) },
    });
    const requestPermission = stubNotification("denied", Promise.resolve("denied"));

    render(<RegisterServiceWorker />);
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("swallows a rejected permission request", async () => {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register: vi.fn().mockResolvedValue({ scope: "/" }) },
    });
    const requestPermission = stubNotification("default", Promise.reject(new Error("gesture")));

    expect(() => render(<RegisterServiceWorker />)).not.toThrow();
    await vi.waitFor(() => expect(requestPermission).toHaveBeenCalled());
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
