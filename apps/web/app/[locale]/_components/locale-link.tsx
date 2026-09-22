"use client";

import Link from "next/link";
import { useLocale } from "next-intl";
import type { ComponentProps } from "react";

import { localeHref } from "../../../lib/i18n/locale-href";

/**
 * `next/link` for the localized marketing pages: string hrefs into the
 * localized tree get the current locale's prefix (see `localeHref`); any other
 * target passes through unchanged. Usable from server components too.
 */
export function LocaleLink({
  href,
  ...props
}: Omit<ComponentProps<typeof Link>, "href"> & { href: string }) {
  const locale = useLocale();
  return <Link href={localeHref(href, locale)} {...props} />;
}
