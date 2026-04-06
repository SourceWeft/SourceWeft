import "./globals.css";
import type { Metadata } from "next";
import { cookies, headers } from "next/headers";

import {
  getLocaleDirection,
  LOCALE_COOKIE_NAME,
  resolveRequestLocale,
} from "../lib/locale";
import { typographyVariableClassName } from "../lib/typography";

import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "SourceWeft",
  description: "SourceWeft Web",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
      { url: "/icon-512.png", type: "image/png", sizes: "512x512" },
    ],
    apple: { url: "/apple-touch-icon.png", sizes: "180x180" },
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
      <body
        className={`${typographyVariableClassName} flex min-h-svh flex-col antialiased`}
      >
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
