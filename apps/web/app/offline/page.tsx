export const metadata = {
  title: "Offline · allowlister remote",
};

export default function OfflinePage() {
  return (
    <main className="shell empty-state">
      <p className="eyebrow">allowlister remote</p>
      <h1>You are offline</h1>
      <p>
        allowlister remote is installed and ready. Reconnect to load the next agent approval request
        — your decisions sync as soon as you are back online.
      </p>
    </main>
  );
}
