import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import { routing } from "../../i18n/routing";
import { ClientMessagesProvider } from "../_components/client-messages-provider";

/**
 * Layout for the localized marketing tree. The root `app/layout.tsx` already
 * renders `<html>`, `<body>` and the providers, so this validates the
 * segment, pins the request locale for static rendering and narrows the client
 * messages to what the marketing client components read. An unknown segment
 * (e.g. `/foo`) is a 404, not a silently-accepted "locale" (§4.1).
 */
export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params,
}: LayoutProps<"/[locale]">) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }
  setRequestLocale(locale);
  return (
    <ClientMessagesProvider area="marketing">{children}</ClientMessagesProvider>
  );
}
