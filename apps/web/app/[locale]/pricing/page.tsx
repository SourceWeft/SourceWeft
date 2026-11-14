import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import { JsonLd } from "../../_components/seo/json-ld";
import { resolveInitialLandingAuthState } from "../../_landing/auth-state-server";
import { SourceWeftFooter } from "../../_landing/components/sourceweft-footer";
import { SourceWeftHeader } from "../../_landing/components/sourceweft-header";
import { PricingSection } from "../../_landing/v1";
import { OG_IMAGE, SITE_NAME } from "../../seo";
import { routing } from "../../../i18n/routing";
import { resolveDeploymentCapabilities } from "../../../lib/billing-edition/capabilities-server";
import { buildAlternates } from "../../../lib/i18n/metadata";
import { pricingJsonLd } from "../../../lib/pricing-json-ld";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/pricing">): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    return {};
  }
  const t = await getTranslations({ locale, namespace: "pricingPage.meta" });
  const alternates = buildAlternates("/pricing", locale);
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

export default async function PricingRoute({
  params,
}: PageProps<"/[locale]/pricing">) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }
  setRequestLocale(locale);

  const [capabilities, authState] = await Promise.all([
    resolveDeploymentCapabilities(),
    resolveInitialLandingAuthState(),
  ]);
  // Without checkout there is no pricing to show (core edition, or the catalog
  // could not be read), so the page does not exist rather than render empty.
  if (
    !capabilities ||
    capabilities.edition !== "commercial" ||
    !capabilities.billing.checkout
  ) {
    notFound();
  }

  return (
    <div className="min-h-svh bg-background text-foreground">
      <JsonLd data={pricingJsonLd(capabilities.billing.catalog)} />
      <SourceWeftHeader authState={authState} />
      <main className="pt-16">
        <PricingSection asPageHeading authState={authState} />
      </main>
      <SourceWeftFooter authState={authState} />
    </div>
  );
}
