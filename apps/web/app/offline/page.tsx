export const metadata = {
  title: "Offline · allowlister remote",
};

export default function OfflinePage() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-3 p-8">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        allowlister remote
      </p>
      <h1 className="text-2xl font-semibold tracking-tight">You are offline</h1>
      <p className="text-muted-foreground">
        allowlister remote is installed and ready. Reconnect to load the next agent approval request
        — your decisions sync as soon as you are back online.
      </p>
    </main>
  );
}
