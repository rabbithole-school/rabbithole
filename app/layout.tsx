import type { Metadata, Viewport } from "next";
import { DevActivityBeacon } from "@/components/dev/DevActivityBeacon";
import { Providers } from "./providers";
import { hankenGrotesk } from "./fonts/hankenGrotesk";
import "./globals.css";
import "katex/dist/katex.min.css";

// Production's canonical web origin; previews can override it explicitly.
const appBaseUrl =
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://rabbithole.school";

export const metadata: Metadata = {
  // Without this Next resolves the og:image against localhost/VERCEL_URL
  // instead of the canonical origin, so scrapers get a relative-ish URL.
  metadataBase: new URL(appBaseUrl),
  title: "Rabbithole",
  description: "AI that makes you think harder.",
  openGraph: {
    title: "Rabbithole",
    description: "AI that makes you think harder.",
    siteName: "Rabbithole",
    // Do not pin og:url here: root metadata is inherited by every route, so
    // scrapers should fall back to the deep-link URL they actually fetched.
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Rabbithole",
    description: "AI that makes you think harder.",
  },
  icons: {
    icon: "/favicon.ico",
  },
};

// viewport-fit=cover lets the app draw edge-to-edge in the iPad shell (the
// safe-area env() padding in globals.css keeps content out of the status
// bar). maximumScale/userScalable stop double-tap and pinch zoom from
// wobbling the app layout on touch; desktop browsers ignore them.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#f9fafa",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={hankenGrotesk.variable}
      data-scroll-behavior="smooth"
      suppressHydrationWarning
    >
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        {/* eslint-disable-next-line @next/next/no-page-custom-font -- App Router loads this in the root layout <head>, so it applies app-wide; the _document.js guidance doesn't apply. */}
        <link
          href="https://fonts.googleapis.com/css2?family=Jost:wght@400;500;600&family=Andika:ital,wght@0,400;0,700;1,400;1,700&display=swap"
          rel="stylesheet"
        />
        <link
          href="https://fonts.cdnfonts.com/css/opendyslexic"
          rel="stylesheet"
        />
      </head>
      <body>
        {process.env.NODE_ENV === "development" ? <DevActivityBeacon /> : null}
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
