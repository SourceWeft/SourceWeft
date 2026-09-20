import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import { routing } from "../../i18n/routing";

/**
 * Layout for the localized marketing tree. The root `app/layout.tsx` already
 * renders `<html>`, `<body>` and the providers, so this only validates the
 * segment and pins the request locale for static rendering. An unknown segment
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
  return children;
}
