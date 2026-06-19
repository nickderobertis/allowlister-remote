import type { Metadata, Viewport } from "next";
import { RegisterServiceWorker } from "../src/pwa/register-service-worker";
import "../src/index.css";

export const metadata: Metadata = {
  title: "allowlister remote",
  description: "Remote PWA approvals for allowlister dynamic requests.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "allowlister remote",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#050816",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <RegisterServiceWorker />
        {children}
      </body>
    </html>
  );
}
