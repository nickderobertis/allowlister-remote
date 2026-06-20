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
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f8fafc" },
    { media: "(prefers-color-scheme: dark)", color: "#050816" },
  ],
};

// Runs before first paint to seed the `.dark` class from the stored preference (or
// the OS setting) so there's no light-then-dark flash. The storage key mirrors
// THEME_STORAGE_KEY in src/lib/theme.tsx, which manages the class thereafter.
const themeBootstrap = `(function(){try{var k="allowlister-remote-theme";var p=localStorage.getItem(k)||"system";var d=p==="dark"||(p==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches);var r=document.documentElement;r.classList.toggle("dark",d);r.style.colorScheme=d?"dark":"light";}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: trusted inline theme bootstrap */}
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
        <RegisterServiceWorker />
        {children}
      </body>
    </html>
  );
}
