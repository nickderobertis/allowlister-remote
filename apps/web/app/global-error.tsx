"use client";

import { ErrorScreen } from "../src/components/error-screen";
import "../src/index.css";

// Last-resort boundary for errors thrown in the root layout itself. It replaces
// the whole document, so it must render its own <html>/<body>.
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <body>
        <ErrorScreen
          title="allowlister remote could not start"
          description="A fatal error stopped the app from loading. Reload to try again."
          onRetry={reset}
        />
      </body>
    </html>
  );
}
