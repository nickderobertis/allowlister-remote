import { Button } from "@/components/ui/button";

// The shared presentation for the app's error and not-found boundaries. Kept token
// styled (no hard-coded colours) so it reads correctly in both themes even when it
// renders outside the ThemeProvider — as the Next error boundaries do.
export function ErrorScreen({
  title,
  description,
  onRetry,
}: {
  title: string;
  description: string;
  onRetry?: () => void;
}) {
  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 p-8" role="alert">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        allowlister remote
      </p>
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="text-muted-foreground">{description}</p>
      {onRetry ? (
        <Button className="self-start" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </main>
  );
}
