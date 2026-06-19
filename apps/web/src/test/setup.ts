import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

beforeEach(() => {
  // Default to a desktop environment so the keyboard-navigation paths are
  // exercised; individual tests override window.matchMedia to assert the mobile
  // (no-keyboard) behavior. jsdom ships neither matchMedia nor scrollIntoView.
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => cleanup());
