import type { Metadata } from "next";
import type { ComponentType } from "react";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import LandingV1 from "../_landing/v1";
import type { LandingAuthState } from "../_landing/components/use-landing-auth-state";
import { MobileHomeGate } from "../mobile-home-gate";
import { routing } from "../../i18n/routing";
import { buildAlternates } from "../../lib/i18n/metadata";

type LandingPageProps = {
  initialAuthState?: LandingAuthState;
};

// Register landing page versions here.
// Set LANDING_VERSION in .env to switch between them.
const VERSIONS: Record<string, ComponentType<LandingPageProps>> = {
  "1": LandingV1,
  // "2": LandingV2,
};

export async function generateMetadata({
  params,
}: PageProps<"/[locale]">): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    return {};
  }
  const t = await getTranslations({ locale, namespace: "metadata" });
  return {
    // `absolute` bypasses the root layout's "%s | SourceWeft" template.
    title: { absolute: t("home.title") },
    description: t("home.description"),
    alternates: buildAlternates("/", locale),
  };
}

export default async function RootPage({ params }: PageProps<"/[locale]">) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }
  setRequestLocale(locale);

  const version = process.env.LANDING_VERSION ?? "1";
  const LandingPage = VERSIONS[version] ?? LandingV1;

  return (
    <MobileHomeGate>
      <LandingPage />
    </MobileHomeGate>
  );
}
