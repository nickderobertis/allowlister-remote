import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { isValidBrokerBase } from "@/lib/broker-config";
import { BrandMark } from "./approval/shared";

// Shown when no broker is configured yet, and reused to change the broker later
// (with `initialValue` seeding the current base and `onCancel` returning to the
// inbox). The PWA is fully static, so the broker URL is a setting this device
// holds (saved to localStorage); the app derives the `/ws/pwa` endpoint from it. A
// `?broker=` deep link skips the first-run case entirely.
export function BrokerSetup({
  onSave,
  onCancel,
  initialValue = "",
}: {
  onSave: (base: string) => void;
  onCancel?: () => void;
  initialValue?: string;
}) {
  const [value, setValue] = useState(initialValue);
  const errorId = useId();
  const trimmed = value.trim();
  const valid = isValidBrokerBase(trimmed);
  // Only nag once the field has content: an empty field is "incomplete", not "wrong".
  const showError = trimmed.length > 0 && !valid;
  const reconfiguring = onCancel !== undefined;

  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 p-8">
      <BrandMark />
      <h1 className="text-2xl font-semibold tracking-tight">
        {reconfiguring ? "Change your broker" : "Connect to your broker"}
      </h1>
      <p className="text-muted-foreground">
        allowlister-remote relays approval requests through a broker you run. Enter its URL to
        connect this device — it is saved on this device only.
      </p>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) onSave(trimmed);
        }}
      >
        <label className="flex flex-col gap-1 text-sm font-medium" htmlFor="broker-url">
          Broker URL
          <input
            id="broker-url"
            name="broker-url"
            type="url"
            inputMode="url"
            autoComplete="off"
            placeholder="wss://broker.example.com"
            value={value}
            aria-invalid={showError}
            aria-describedby={showError ? errorId : undefined}
            onChange={(event) => setValue(event.target.value)}
            className="rounded-md border border-border bg-background px-3 py-2 text-sm font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          />
        </label>
        {showError ? (
          <p id={errorId} role="alert" className="text-xs text-destructive">
            Enter a <code>ws://</code> or <code>wss://</code> URL.
          </p>
        ) : null}
        <div className="flex gap-3">
          {reconfiguring ? (
            <Button type="button" variant="outline" className="flex-1" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
          <Button type="submit" className="flex-1" disabled={!valid}>
            Connect
          </Button>
        </div>
      </form>
      <p className="text-xs text-muted-foreground">
        Tip: open this app with <code>?broker=wss://…</code> to set the broker automatically.
      </p>
    </main>
  );
}
