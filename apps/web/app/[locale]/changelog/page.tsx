import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import { loadChangelogEntries } from "../../../lib/changelog";
import { OG_IMAGE, SITE_NAME } from "../../seo";
import { routing } from "../../../i18n/routing";
import { buildAlternates } from "../../../lib/i18n/metadata";
import { ChangelogPage } from "./changelog-page";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/changelog">): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    return {};
  }
  const t = await getTranslations({ locale, namespace: "changelog.meta" });
  const alternates = buildAlternates("/changelog", locale);
  const title = t("title");
  const description = t("description");
  return {
    title,
    description,
    alternates,
    openGraph: {
      description,
      images: [OG_IMAGE],
      siteName: SITE_NAME,
      title,
      type: "website",
      url: alternates.canonical,
    },
    twitter: {
      card: "summary_large_image",
      description,
      images: [OG_IMAGE.url],
      title,
    },
  };
}

export default async function ChangelogRoute({
  params,
}: PageProps<"/[locale]/changelog">) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }
  setRequestLocale(locale);
  return <ChangelogPage entries={loadChangelogEntries()} />;
}
