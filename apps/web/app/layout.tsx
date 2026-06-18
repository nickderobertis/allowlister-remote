import type { Metadata, Viewport } from "next";
import "../src/index.css";

export const metadata: Metadata = {
  title: "allowlister remote",
  description: "Remote PWA approvals for allowlister dynamic requests.",
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  themeColor: "#050816",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
