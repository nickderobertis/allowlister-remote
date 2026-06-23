import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The PWA has no server of its own: the broker is the only backend, reached
  // over a WebSocket, and the broker URL is a client-side setting. So the app
  // builds to a fully static bundle (`out/`) that any static host — or the
  // bundled `@nickderobertis/allowlister-remote-web` server — can serve.
  output: "export",
  // Static export cannot run the Next image optimizer, so serve images as-is.
  images: { unoptimized: true },
  // React Compiler auto-memoizes components and hooks at build time (the
  // equivalent of hand-written useMemo/useCallback/memo), so a re-render from
  // state that does not touch a subtree skips re-running that subtree, and the
  // per-render decision-surface work each card runs is cached across renders
  // where its request is unchanged. The measured effect on this PWA — and the
  // bundle-size cost — live in scripts/web-render-cost.mjs (`just render-cost`).
  reactCompiler: true,
};

export default nextConfig;
