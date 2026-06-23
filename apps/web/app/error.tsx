"use client";

import { ErrorScreen } from "../src/components/error-screen";

// Route-segment error boundary. A render-time throw anywhere in the app lands
// here instead of blanking the whole static bundle; `reset` retries the segment.
export default function ErrorBoundary({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <ErrorScreen
      title="Something went wrong"
      description="The approval view hit an unexpected error. You can retry — your pending approvals are held by the broker, not this page."
      onRetry={reset}
    />
  );
}
