import "./globals.css";
import Script from "next/script";
import {
  serverPublicRuntimeConfig,
  serializePublicConfig,
} from "../lib/public-runtime-config";
import type { Metadata } from "next";
import { connection } from "next/server";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import {
  DEFAULT_LOCALE,
  getLocaleMeta,
  isLocale,
} from "@sourceweft/i18n/locales";

import { CLIENT_NAMESPACES, pickMessages } from "../i18n/client-messages";
import { resolveDeploymentCapabilities } from "../lib/billing-edition/capabilities-server";
import { resolveWebAuthPageConfig } from "../lib/auth/auth-config-server";
import { SeoJsonLd } from "./_components/seo/json-ld";
import { AnalyticsScripts } from "../lib/analytics/analytics-scripts";
import { Providers } from "./providers";
import { DesktopWindowChrome } from "./_components/desktop-window-chrome";
import {
  LAUNCH_COVER_SCRIPT,
  LAUNCH_COVER_STYLE,
} from "./_components/mobile-launch-cover";
import { FRAMED_PAGE_SCRIPT } from "./_components/framed-page";
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
  const [capabilities, authPageConfig] = await Promise.all([
    resolveDeploymentCapabilities(),
    resolveWebAuthPageConfig(),
  ]);

  // The proxy resolves the locale per request and next-intl surfaces it here, so
  // `<html lang/dir>` is correct even for crawlers (D6). `getMessages()` returns
  // the catalog from `i18n/request.ts`. Only the shell's namespaces go to the
  // client here; route areas that need more nest their own provider.
  const resolvedLocale = await getLocale();
  const localeMeta = getLocaleMeta(
    isLocale(resolvedLocale) ? resolvedLocale : DEFAULT_LOCALE,
  );
  const messages = pickMessages(await getMessages(), CLIENT_NAMESPACES.root);

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
        {/* In the mobile app, keeps its launch screen up until the page has
            rendered, so the web view never shows a blank page. */}
        <style id="sourceweft-launch-cover">{LAUNCH_COVER_STYLE}</style>
        <Script
          id="sourceweft-launch-cover-script"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: LAUNCH_COVER_SCRIPT }}
        />
        {/* Inside a frame (the mobile app's terms and privacy sheet), pages
            drop the site header and footer. */}
        <Script
          id="sourceweft-framed-page-script"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: FRAMED_PAGE_SCRIPT }}
        />
      </head>
      <AnalyticsScripts config={runtimeConfig.analytics} />
      <body className="flex min-h-svh flex-col antialiased">
        <NextIntlClientProvider locale={resolvedLocale} messages={messages}>
          <Providers
            initialCapabilities={capabilities}
            requireEmailVerification={authPageConfig.requireEmailVerification}
            appleSignIn={authPageConfig.appleSignIn}
          >
            <DesktopWindowChrome />
            {children}
          </Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
