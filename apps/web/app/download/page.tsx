import type { Metadata } from "next";
import { headers } from "next/headers";

import { resolveInitialLandingAuthState } from "../_landing/auth-state-server";
import { SITE_NAME, SITE_URL } from "../seo";
import { detectPlatform } from "../../lib/detect-platform";
import {
  DOWNLOAD_CHANNEL_REVALIDATE_SECONDS,
  fetchDownloadChannels,
  type DownloadChannelManifest,
} from "../../lib/download-channels";
import { DOWNLOAD_FAQ_ITEMS, PLATFORM_DISPLAY } from "./download-content";
import { DownloadPage } from "./download-page";

export const revalidate = DOWNLOAD_CHANNEL_REVALIDATE_SECONDS;

const description =
  "Download SourceWeft for macOS and Windows, find the iOS and Android apps, or use the web app, browser extension, and self-hosted Docker bundle. Every desktop installer is listed with its SHA-256 checksum.";

export const metadata: Metadata = {
  title: "Download SourceWeft",
  description,
  alternates: {
    canonical: `${SITE_URL}/download`,
  },
  openGraph: {
    title: "Download SourceWeft",
    description,
    siteName: SITE_NAME,
    type: "website",
    url: `${SITE_URL}/download`,
    images: [
      {
        url: `${SITE_URL}/download/desktop-chat-light.png`,
        width: 2880,
        height: 1800,
        alt: "SourceWeft desktop app on macOS",
      },
    ],
  },
};

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

export default async function DownloadRoute() {
  const [authState, channels, requestHeaders] = await Promise.all([
    resolveInitialLandingAuthState(),
    fetchDownloadChannels(),
    headers(),
  ]);
  const initialPlatform = detectPlatform({
    userAgent: requestHeaders.get("user-agent") ?? undefined,
  });
  const displayed = channels.stable ?? channels.preview;
  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: DOWNLOAD_FAQ_ITEMS.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: { "@type": "Answer", text: item.answer },
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
