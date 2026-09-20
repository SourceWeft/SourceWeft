import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import { OG_IMAGE, SITE_NAME } from "../../seo";
import { routing } from "../../../i18n/routing";
import { buildAlternates } from "../../../lib/i18n/metadata";
import { AboutPage } from "./about-page";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/about">): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    return {};
  }
  const t = await getTranslations({ locale, namespace: "about.meta" });
  const alternates = buildAlternates("/about", locale);
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

export default async function AboutRoute({
  params,
}: PageProps<"/[locale]/about">) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }
  setRequestLocale(locale);
  return <AboutPage />;
}
