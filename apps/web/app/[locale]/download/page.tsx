import type { Metadata } from "next";
import { headers } from "next/headers";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import { resolveInitialLandingAuthState } from "../../_landing/auth-state-server";
import { SITE_NAME, SITE_URL } from "../../seo";
import { detectPlatform } from "../../../lib/detect-platform";
import {
  fetchDownloadChannels,
  type DownloadChannelManifest,
} from "../../../lib/download-channels";
import { routing } from "../../../i18n/routing";
import { buildAlternates } from "../../../lib/i18n/metadata";
import { DOWNLOAD_FAQ_KEYS, PLATFORM_DISPLAY } from "./download-content";
import { DownloadPage } from "./download-page";

// Next parses segment config statically, so this has to be a literal.
// Keep it equal to DOWNLOAD_CHANNEL_REVALIDATE_SECONDS in lib/download-channels.
export const revalidate = 300;

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/download">): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    return {};
  }
  const t = await getTranslations({ locale, namespace: "download.meta" });
  const alternates = buildAlternates("/download", locale);
  const title = t("title");
  const description = t("description");
  return {
    title,
    description,
    alternates,
    openGraph: {
      title,
      description,
      siteName: SITE_NAME,
      type: "website",
      url: alternates.canonical,
      images: [
        {
          url: `${SITE_URL}/download/desktop-chat-light.png`,
          width: 2880,
          height: 1800,
          alt: t("ogImageAlt"),
        },
      ],
    },
  };
}

function softwareJsonLd(manifest: DownloadChannelManifest) {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "SourceWeft",
    applicationCategory: "BusinessApplication",
    operatingSystem: PLATFORM_DISPLAY.filter((display) =>
      manifest.artifacts.some((artifact) => artifact.platform === display.id),
    )
      .map((display) => display.label)
      .join(", "),
    softwareVersion: manifest.version,
    releaseNotes: manifest.releaseNotesUrl,
    downloadUrl: manifest.artifacts.map((artifact) => artifact.url),
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    url: `${SITE_URL}/download`,
  };
}

export default async function DownloadRoute({
  params,
}: PageProps<"/[locale]/download">) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }
  setRequestLocale(locale);

  const [authState, channels, requestHeaders, t] = await Promise.all([
    resolveInitialLandingAuthState(),
    fetchDownloadChannels(),
    headers(),
    getTranslations({ locale, namespace: "download.faq" }),
  ]);
  const initialPlatform = detectPlatform({
    userAgent: requestHeaders.get("user-agent") ?? undefined,
  });
  const displayed = channels.stable ?? channels.preview;
  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: DOWNLOAD_FAQ_KEYS.map((key) => ({
      "@type": "Question",
      name: t(`items.${key}.question`),
      acceptedAnswer: { "@type": "Answer", text: t(`items.${key}.answer`) },
    })),
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
      {displayed ? (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(softwareJsonLd(displayed)),
          }}
        />
      ) : null}
      <DownloadPage
        channels={channels}
        initialAuthState={authState}
        initialPlatform={initialPlatform}
      />
    </>
  );
}
