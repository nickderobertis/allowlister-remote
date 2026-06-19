import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

// A small visual key cap used to surface a keyboard shortcut inline next to the
// action it triggers, so every desktop shortcut is discoverable from the UI.
// Hosting buttons carry an explicit `aria-label`, so the glyph stays out of
// their accessible name without needing `aria-hidden`.
export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded border border-border bg-muted px-1 font-mono text-[0.7rem] font-medium leading-none text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}
