import type { Metadata } from "next";
import type { PublicSharedArtifactResponse } from "@sourceweft/contracts";
import { SharedArtifactViewer } from "./shared-artifact-viewer";

export const dynamic = "force-dynamic";

/**
 * Server-side API base. On the server `apiBaseUrl` resolves from the configured
 * public URL (or localhost in dev), which is what SSR needs to reach the API.
 */
function serverApiBaseUrl() {
  return (
    process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "") ||
    "http://localhost:3001"
  );
}

async function fetchShare(
  token: string,
): Promise<PublicSharedArtifactResponse["artifact"] | null> {
  try {
    const res = await fetch(
      `${serverApiBaseUrl()}/v1/public/shares/${encodeURIComponent(token)}`,
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
    : undefined;

  return {
    title,
    description,
    // Canonical for this content (the old `/s/:token` permanently redirects
    // here), so the two paths never split SEO signals.
    alternates: { canonical: `/artifact/${token}` },
    // The share token is in this page's URL; keep it out of the Referer header
    // on any outbound navigation/subresource so it can't leak to third parties.
    referrer: "no-referrer",
    // A public link is a deliberate publish → indexable for reach, unless the
    // owner opted this share out.
    robots: artifact.noindex ? { index: false, follow: false } : undefined,
    openGraph: { title, description, images, type: "article" },
    twitter: {
      card: images ? "summary_large_image" : "summary",
      title,
      description,
      images: images?.map((i) => i.url),
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
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-background px-6 text-center">
        <h1 className="text-lg font-medium">This share is not available</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          The link may have been revoked or has expired.
        </p>
        <a
          className="text-sm font-medium text-primary underline-offset-4 hover:underline"
          href="/"
        >
          Go to SourceWeft
        </a>
      </main>
    );
  }

  return <SharedArtifactViewer artifact={artifact} />;
}
