import "./globals.css";
import Script from "next/script";
import {
  serverPublicRuntimeConfig,
  serializePublicConfig,
} from "../lib/public-runtime-config";
import { GoogleTagManager } from "@next/third-parties/google";
import type { Metadata } from "next";
import { connection } from "next/server";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import {
  DEFAULT_LOCALE,
  getLocaleMeta,
  isLocale,
} from "@sourceweft/i18n/locales";

import { resolveDeploymentCapabilities } from "../lib/billing-edition/capabilities-server";
import { resolveRequireEmailVerification } from "../lib/auth/auth-config-server";
import { SeoJsonLd } from "./_components/seo/json-ld";
import { Providers } from "./providers";
import { DesktopWindowChrome } from "./_components/desktop-window-chrome";
import {
  DEFAULT_DESCRIPTION,
  DEFAULT_TITLE,
  OG_IMAGE,
  SITE_NAME,
  SITE_URL,
} from "./seo";

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
  // Runtime config (base URL, GTM) is injected at container start, so never prerender with build-time values.
  await connection();
  const runtimeConfig = serverPublicRuntimeConfig();
  const gtmId = runtimeConfig.gtmId;
  const [capabilities, requireEmailVerification] = await Promise.all([
    resolveDeploymentCapabilities(),
    resolveRequireEmailVerification(),
  ]);

  // The proxy resolves the locale per request and next-intl surfaces it here, so
  // `<html lang/dir>` is correct even for crawlers (D6). `getMessages()` returns
  // the catalog from `i18n/request.ts` for the client provider.
  const resolvedLocale = await getLocale();
  const localeMeta = getLocaleMeta(
    isLocale(resolvedLocale) ? resolvedLocale : DEFAULT_LOCALE,
  );
  const messages = await getMessages();

  return (
    <html
      lang={localeMeta.htmlLang}
      dir={localeMeta.dir}
      suppressHydrationWarning
    >
      <head>
        <Script
          id="sourceweft-runtime-config"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{
            __html: `window.__SOURCEWEFT_CONFIG__=${serializePublicConfig(runtimeConfig)};`,
          }}
        />
        <SeoJsonLd />
      </head>
      {gtmId ? <GoogleTagManager gtmId={gtmId} /> : null}
      <body className="flex min-h-svh flex-col antialiased">
        <NextIntlClientProvider locale={resolvedLocale} messages={messages}>
          <Providers
            initialCapabilities={capabilities}
            requireEmailVerification={requireEmailVerification}
          >
            <DesktopWindowChrome />
            {children}
          </Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
