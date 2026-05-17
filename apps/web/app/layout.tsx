import "./globals.css";
import { GoogleAnalytics } from "@next/third-parties/google";
import type { Metadata } from "next";
import { cookies, headers } from "next/headers";

import {
  getLocaleDirection,
  LOCALE_COOKIE_NAME,
  resolveRequestLocale,
} from "../lib/locale";

import { SeoJsonLd } from "./_components/seo/json-ld";
import { Providers } from "./providers";
import {
  DEFAULT_DESCRIPTION,
  DEFAULT_TITLE,
  OG_IMAGE,
  SITE_NAME,
  SITE_URL,
} from "./seo";

const gaMeasurementId = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID?.trim();

export const metadata: Metadata = {
  alternates: {
    canonical: SITE_URL,
  },
  description: DEFAULT_DESCRIPTION,
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
      { url: "/icon-512.png", type: "image/png", sizes: "512x512" },
    ],
    apple: { url: "/apple-touch-icon.png", sizes: "180x180" },
  },
  metadataBase: new URL(SITE_URL),
  openGraph: {
    description: DEFAULT_DESCRIPTION,
    images: [OG_IMAGE],
    siteName: SITE_NAME,
    title: DEFAULT_TITLE,
    type: "website",
    url: SITE_URL,
  },
  title: {
    default: DEFAULT_TITLE,
    template: `%s | ${SITE_NAME}`,
  },
  twitter: {
    card: "summary_large_image",
    description: DEFAULT_DESCRIPTION,
    images: [OG_IMAGE.url],
    title: DEFAULT_TITLE,
  },
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = await cookies();
  const requestHeaders = await headers();

  const locale = resolveRequestLocale({
    acceptLanguage: requestHeaders.get("accept-language"),
    cookieLocale: cookieStore.get(LOCALE_COOKIE_NAME)?.value,
    headerLocale: requestHeaders.get("x-sourceweft-locale"),
  });
  const direction = getLocaleDirection(locale);

  return (
    <html lang={locale} dir={direction} suppressHydrationWarning>
      <head>
        <SeoJsonLd />
      </head>
      <body className="flex min-h-svh flex-col antialiased">
        <Providers>{children}</Providers>
      </body>
      {gaMeasurementId ? <GoogleAnalytics gaId={gaMeasurementId} /> : null}
    </html>
  );
}
