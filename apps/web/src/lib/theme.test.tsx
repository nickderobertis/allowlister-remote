import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeToggle } from "../components/theme-toggle";
import { THEME_STORAGE_KEY, ThemeProvider, useTheme } from "./theme";

// A controllable matchMedia: the dark query reflects `darkState` and remembers
// its change listeners so a test can simulate the OS flipping themes. Any other
// query (e.g. desktop detection) just reports true, matching the global setup.
let darkState = false;
const darkListeners = new Set<(event: MediaQueryListEvent) => void>();

function installMatchMedia() {
  window.matchMedia = vi.fn().mockImplementation((query: string) => {
    const isDark = query.includes("dark");
    return {
      get matches() {
        return isDark ? darkState : true;
      },
      media: query,
      onchange: null,
      addEventListener: (_type: string, cb: (event: MediaQueryListEvent) => void) => {
        if (isDark) darkListeners.add(cb);
      },
      removeEventListener: (_type: string, cb: (event: MediaQueryListEvent) => void) => {
        if (isDark) darkListeners.delete(cb);
      },
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
  });
}

function setSystemDark(value: boolean) {
  act(() => {
    darkState = value;
    for (const cb of darkListeners) {
      cb({ matches: value } as MediaQueryListEvent);
    }
  });
}

function isDarkApplied(): boolean {
  return document.documentElement.classList.contains("dark");
}

beforeEach(() => {
  darkState = false;
  darkListeners.clear();
  window.localStorage.clear();
  document.documentElement.classList.remove("dark");
  document.documentElement.removeAttribute("style");
  installMatchMedia();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ThemeProvider", () => {
  it("defaults to the system preference and paints light when the OS is light", () => {
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );

    expect(screen.getByRole("button", { name: /Theme: System/ })).toBeInTheDocument();
    expect(isDarkApplied()).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  it("follows the OS into dark mode while on the system preference", () => {
    darkState = true;
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );

    expect(isDarkApplied()).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("reacts live when the OS theme changes under the system preference", () => {
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );
    expect(isDarkApplied()).toBe(false);

    setSystemDark(true);
    expect(isDarkApplied()).toBe(true);

    setSystemDark(false);
    expect(isDarkApplied()).toBe(false);
  });

  it("adopts a stored preference on mount", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");

    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );

    expect(screen.getByRole("button", { name: /Theme: Dark/ })).toBeInTheDocument();
    expect(isDarkApplied()).toBe(true);
  });

  it("falls back to system when the stored value is unrecognized", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "neon");

    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );

    expect(screen.getByRole("button", { name: /Theme: System/ })).toBeInTheDocument();
  });

  it("throws when useTheme is used without a provider", () => {
    function Orphan() {
      useTheme();
      return null;
    }
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => render(<Orphan />)).toThrow(/useTheme must be used within a ThemeProvider/);

    consoleError.mockRestore();
  });
});

describe("ThemeToggle", () => {
  it("cycles system → light → dark → system and persists each choice", async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );

    const button = () => screen.getByRole("button");

    // Starts on system (OS is light here), so nothing is pinned yet.
    expect(button()).toHaveAccessibleName(/Theme: System\. Switch to Light\./);

    await user.click(button());
    expect(button()).toHaveAccessibleName(/Theme: Light\. Switch to Dark\./);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(isDarkApplied()).toBe(false);

    await user.click(button());
    expect(button()).toHaveAccessibleName(/Theme: Dark\. Switch to System\./);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(isDarkApplied()).toBe(true);

    await user.click(button());
    expect(button()).toHaveAccessibleName(/Theme: System\. Switch to Light\./);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");
  });

  it("keeps a pinned light preference even when the OS switches to dark", async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );

    await user.click(screen.getByRole("button")); // pin light
    expect(isDarkApplied()).toBe(false);

    // The OS going dark must not override an explicit light pin.
    setSystemDark(true);
    expect(isDarkApplied()).toBe(false);
  });
});
