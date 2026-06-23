import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Kbd } from "@/components/ui/kbd";
import { useFocusTrap } from "@/lib/focus-trap";
import { SHORTCUT_GROUPS } from "@/lib/keyboard";

export function ShortcutsHint({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="fixed bottom-4 right-4 z-40">
      <Button variant="outline" size="sm" onClick={onOpen} aria-label="Show keyboard shortcuts">
        Shortcuts
        <Kbd>?</Kbd>
      </Button>
    </div>
  );
}

export function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  // Trap focus inside the dialog and return it to the opener on close, so Tab
  // can't reach the inbox behind it. Escape is handled by the app's global map.
  const dialogRef = useFocusTrap<HTMLDivElement>(true);

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="shortcuts-title"
    >
      <Card className="max-h-full w-full max-w-lg overflow-y-auto">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle id="shortcuts-title">Keyboard shortcuts</CardTitle>
          <Button variant="ghost" size="sm" aria-label="Close shortcuts" onClick={onClose}>
            Close
            <Kbd>Esc</Kbd>
          </Button>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group.title} className="flex flex-col gap-2">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {group.title}
              </h3>
              <dl className="flex flex-col gap-1.5">
                {group.shortcuts.map((shortcut) => (
                  <div
                    key={shortcut.description}
                    className="flex items-center justify-between gap-4"
                  >
                    <dt className="text-sm text-foreground">{shortcut.description}</dt>
                    <dd className="flex shrink-0 items-center gap-1">
                      {shortcut.keys.map((key) => (
                        <Kbd key={key}>{key}</Kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
