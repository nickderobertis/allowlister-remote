import { useEffect, useRef, useState } from "react";

// Keyboard navigation is a desktop-only affordance. On touch/mobile the inbox is
// tap-first, so we neither bind global keys nor render the shortcut hints. We
// require both a wide viewport and a fine pointer so phones and tablets — which
// report a coarse pointer — are excluded even when rotated to a wide layout.
const DESKTOP_QUERY = "(min-width: 768px) and (pointer: fine)";

function matchesDesktop(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(DESKTOP_QUERY).matches;
}

// Tracks whether the app is running on a desktop-class device, re-evaluating as
// the viewport or pointer changes (e.g. attaching a mouse, resizing a window).
export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(matchesDesktop);

  useEffect(() => {
    /* v8 ignore next 3 -- jsdom always provides matchMedia via the test setup. */
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const query = window.matchMedia(DESKTOP_QUERY);
    const update = () => setIsDesktop(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return isDesktop;
}

export type ShortcutHandler = (event: KeyboardEvent) => void;
// Maps a KeyboardEvent.key value (e.g. "a", "Enter", "ArrowDown", "?") to its
// handler. See SHORTCUT_GROUPS for the user-facing documentation of each key.
export type ShortcutMap = Record<string, ShortcutHandler>;

// Binds a single document-level keydown listener that dispatches by event.key.
// Handlers are read through a ref so callers can pass a freshly built map every
// render without re-subscribing. Shortcuts never fire while the user is typing
// in a form field or while focus sits on another interactive control, so native
// Tab + Enter/Space activation keeps working; Escape is always allowed through so
// overlays can be dismissed from anywhere.
export function useKeyboardShortcuts(shortcuts: ShortcutMap, enabled: boolean): void {
  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;

  useEffect(() => {
    if (!enabled) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const target = event.target as HTMLElement | null;
      const inInteractive = target?.closest?.(
        "a, button, input, textarea, select, [contenteditable]",
      );
      if (inInteractive && event.key !== "Escape") {
        return;
      }
      const handler = shortcutsRef.current[event.key];
      if (handler) {
        event.preventDefault();
        handler(event);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}

export interface ShortcutDoc {
  // The key caps to render, in the order they should appear.
  keys: string[];
  description: string;
}

export interface ShortcutGroup {
  title: string;
  shortcuts: ShortcutDoc[];
}

// The single source of truth for the shortcuts panel (the `?` overlay). Inline
// hints throughout the UI mirror these so every action is discoverable without
// opening the panel.
export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "Global",
    shortcuts: [{ keys: ["?"], description: "Show or hide this shortcuts panel" }],
  },
  {
    title: "Approvals inbox",
    shortcuts: [
      { keys: ["↓"], description: "Focus the next approval" },
      { keys: ["↑"], description: "Focus the previous approval" },
      { keys: ["Enter", "O"], description: "Open the focused approval" },
      { keys: ["A"], description: "Allow the focused approval" },
      { keys: ["D"], description: "Deny the focused approval" },
    ],
  },
  {
    title: "Approval detail",
    shortcuts: [
      { keys: ["A"], description: "Allow this request" },
      { keys: ["D"], description: "Deny this request" },
      { keys: ["Esc", "B"], description: "Back to the inbox" },
      { keys: ["F", "J"], description: "Tool calls: formatted / JSON view" },
    ],
  },
];
