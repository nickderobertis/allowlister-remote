"use client";

import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";

// One key, shared with the no-flash bootstrap script in app/layout.tsx. Keep the
// two literals in sync — the script runs before React hydrates and seeds the same
// class this provider manages.
export const THEME_STORAGE_KEY = "allowlister-remote-theme";

// "system" follows the OS setting and re-evaluates as it changes; "light"/"dark"
// pin the choice. This is the user's *preference*; `resolved` is what's painted.
export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

interface ThemeContextValue {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function prefersDark(): boolean {
  /* v8 ignore next 3 -- jsdom always provides matchMedia via the test setup. */
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function readStoredPreference(): ThemePreference {
  /* v8 ignore next 3 -- SSR has no localStorage; the client effect re-reads it. */
  if (typeof window === "undefined") {
    return "system";
  }
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
}

function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference === "system") {
    return prefersDark() ? "dark" : "light";
  }
  return preference;
}

// Mirror the resolved theme onto <html>: the `.dark` class flips the CSS token
// set and `color-scheme` lines up native form controls and scrollbars.
function applyTheme(resolved: ResolvedTheme): void {
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Start from "system" so the server-rendered markup and the first client render
  // agree; the mount effect then adopts whatever the visitor last chose.
  const [preference, setPreferenceState] = useState<ThemePreference>("system");
  const [resolved, setResolved] = useState<ResolvedTheme>("dark");

  useEffect(() => {
    setPreferenceState(readStoredPreference());
  }, []);

  useEffect(() => {
    const apply = () => {
      const next = resolveTheme(preference);
      setResolved(next);
      applyTheme(next);
    };
    apply();
    // Only "system" tracks live OS changes; a pinned preference is static.
    if (preference !== "system") {
      return;
    }
    /* v8 ignore next 3 -- jsdom always provides matchMedia via the test setup. */
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [preference]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    /* v8 ignore next -- SSR has no localStorage; clicks only happen client-side. */
    if (typeof window !== "undefined") {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    }
  }, []);

  return (
    <ThemeContext.Provider value={{ preference, resolved, setPreference }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
