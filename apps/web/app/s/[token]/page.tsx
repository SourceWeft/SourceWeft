import type { Metadata } from "next";
import type { PublicSharedArtifactResponse } from "@sourceweft/contracts";

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
  const description = "Made with SourceWeft";
  const images = artifact.previewImageUrl
    ? [{ url: artifact.previewImageUrl }]
    : undefined;

  return {
    title,
    description,
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

  const title = artifact.title || "Shared artifact";

  return (
    <main className="flex min-h-dvh flex-col bg-background">
      <header className="flex items-center justify-between gap-3 border-b px-4 py-2.5">
        <span className="truncate text-sm font-medium">{title}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {artifact.viewCount} {artifact.viewCount === 1 ? "view" : "views"}
        </span>
      </header>

      <div className="min-h-0 flex-1">
        {artifact.fileUrl ? (
          // Sandboxed + cross-checked by the /raw endpoint's `CSP: sandbox`
          // header: the artifact runs in an opaque origin and cannot reach this
          // page, its cookies, or any other artifact.
          <iframe
            title={title}
            src={artifact.fileUrl}
            className="h-full w-full border-0"
            sandbox="allow-scripts allow-popups allow-forms allow-modals"
          />
        ) : (
          <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
            Nothing to preview.
          </div>
        )}
      </div>

      <footer className="border-t px-4 py-2 text-center">
        <a
          className="text-xs text-muted-foreground hover:text-foreground"
          href="/"
          rel="noopener"
        >
          Made with <span className="font-medium">SourceWeft</span>
        </a>
      </footer>
    </main>
  );
}
