import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The PWA has no server of its own: the broker is the only backend, reached
  // over a WebSocket, and the broker URL is a client-side setting. So the app
  // builds to a fully static bundle (`out/`) that any static host — or the
  // bundled `@nickderobertis/allowlister-remote-web` server — can serve.
  output: "export",
  // Static export cannot run the Next image optimizer, so serve images as-is.
  images: { unoptimized: true },
};

export default nextConfig;
