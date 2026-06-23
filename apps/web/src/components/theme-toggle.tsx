"use client";

import type { ReactElement, SVGProps } from "react";
import { Button } from "@/components/ui/button";
import { type ThemePreference, useTheme } from "@/lib/theme";

// Cycle order matches the mental model: start on the OS default, then pin light,
// then pin dark, then back to following the system.
const ORDER: ThemePreference[] = ["system", "light", "dark"];

const LABELS: Record<ThemePreference, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

function SunIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}

function MoonIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function MonitorIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

const ICONS: Record<ThemePreference, (props: SVGProps<SVGSVGElement>) => ReactElement> = {
  system: MonitorIcon,
  light: SunIcon,
  dark: MoonIcon,
};

// A single button that cycles system → light → dark. On desktop the label names
// the active preference; on mobile only the icon shows to save screen real estate.
// The aria-label always announces the active preference and what the next press
// will do, so screen-reader users (and the icon-only mobile button) aren't guessing.
export function ThemeToggle({ className }: { className?: string }) {
  const { preference, setPreference } = useTheme();
  const next = ORDER[(ORDER.indexOf(preference) + 1) % ORDER.length] ?? "system";
  const Icon = ICONS[preference];

  return (
    <Button
      variant="outline"
      size="sm"
      className={className}
      aria-label={`Theme: ${LABELS[preference]}. Switch to ${LABELS[next]}.`}
      onClick={() => setPreference(next)}
    >
      <Icon />
      <span className="hidden md:inline">{LABELS[preference]}</span>
    </Button>
  );
}
