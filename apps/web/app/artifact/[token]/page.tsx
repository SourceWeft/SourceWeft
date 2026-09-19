import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { PublicSharedArtifactResponse } from "@sourceweft/contracts";
import { SharedArtifactViewer } from "./shared-artifact-viewer";

export const dynamic = "force-dynamic";

import { internalApiBaseUrl } from "../../../lib/internal-api-base-url";
import { OG_IMAGE, SITE_NAME, SITE_URL } from "../../seo";

async function fetchShare(
  token: string,
): Promise<PublicSharedArtifactResponse["artifact"] | null> {
  try {
    const res = await fetch(
      `${internalApiBaseUrl()}/v1/public/shares/${encodeURIComponent(token)}`,
      { cache: "no-store" },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as PublicSharedArtifactResponse;
    return body.artifact ?? null;
  } catch {
    return null;
  }
}

/** Human noun per artifact type, for the fallback description sentence. */
const ARTIFACT_TYPE_NOUNS: Record<string, string> = {
  file: "file",
  report: "report",
  slides: "presentation",
  mindmap: "mind map",
  podcast: "podcast",
  audio_overview: "audio overview",
  video_overview: "video overview",
  video_presentation: "video presentation",
  flashcards: "set of flashcards",
  quiz: "quiz",
  table: "table",
  infographic: "infographic",
  image: "image",
};

/**
 * SEO/social description: prefer the backend's content-derived summary, and
 * fall back to a title + type sentence so the tag is never empty or generic.
 */
function artifactDescription(
  artifact: NonNullable<PublicSharedArtifactResponse["artifact"]>,
): string {
  if (artifact.description) {
    return artifact.description;
  }
  const noun = ARTIFACT_TYPE_NOUNS[artifact.artifactType] ?? "artifact";
  const name = artifact.title || "A shared artifact";
  return `${name} — a ${noun} shared on SourceWeft.`;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  const artifact = await fetchShare(token);

  if (!artifact) {
    return { title: "Shared artifact", robots: { index: false } };
  }

  const title = artifact.title || "Shared artifact";
  const description = artifactDescription(artifact);
  const images = artifact.previewImageUrl
    ? [{ url: artifact.previewImageUrl }]
    : [OG_IMAGE];
  const canonicalPath = `/artifact/${token}`;

  return {
    title,
    description,
    // Canonical for this content (the old `/s/:token` permanently redirects
    // here), so the two paths never split SEO signals.
    alternates: { canonical: canonicalPath },
    // The share token is in this page's URL; keep it out of the Referer header
    // on any outbound navigation/subresource so it can't leak to third parties.
    referrer: "no-referrer",
    // A public link is a deliberate publish → indexable for reach, unless the
    // owner opted this share out.
    robots: artifact.noindex ? { index: false, follow: false } : undefined,
    openGraph: {
      title,
      description,
      images,
      siteName: SITE_NAME,
      type: "article",
      url: `${SITE_URL}${canonicalPath}`,
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: images.map((image) => image.url),
    },
  };
}

export default async function SharedArtifactPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const artifact = await fetchShare(token);

  if (!artifact) {
    // A revoked or expired link must 404 rather than serve a 200 "unavailable"
    // page, which search engines treat as a soft 404.
    notFound();
  }

  return <SharedArtifactViewer artifact={artifact} />;
}
