"use client";

import { artifactVersionMediaProjectionSchema } from "@sourceweft/contracts";
import { VideoPresentationExportControls } from "./video-presentation-export";

export type VideoPresentationPreviewProps = {
  chromeless?: boolean;
  downloadUrl?: string | null;
  errorMessage?: string | null;
  /** Trusted file URL for current/public views when no exact projection is supplied. */
  fileUrl?: string | null;
  payload: Record<string, unknown>;
  previewImageUrl?: string | null;
  title: string;
};

export function VideoPresentationPreview({
  chromeless,
  downloadUrl: fallbackDownloadUrl,
  errorMessage,
  fileUrl,
  payload,
  previewImageUrl,
  title,
}: VideoPresentationPreviewProps) {
  const exact = artifactVersionMediaProjectionSchema.safeParse(payload);
  const media = exact.success ? exact.data.media : null;
  const mediaUrl = media?.url ?? (chromeless ? fileUrl : null) ?? null;
  const downloadUrl =
    media?.downloadUrl ??
    (chromeless ? (fallbackDownloadUrl ?? fileUrl) : null) ??
    null;
  const coverUrl = exact.success
    ? (exact.data.coverImage?.url ?? previewImageUrl ?? null)
    : (previewImageUrl ?? null);
  const displayTitle = exact.success ? exact.data.title : title;
  if (!mediaUrl) {
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-center">
        <p className="text-sm font-medium text-destructive">
          Video presentation is unavailable
        </p>
        <p className="mt-2 text-xs leading-5 text-destructive/80">
          {errorMessage ??
            "This artifact version does not contain a trusted rendered video."}
        </p>
      </div>
    );
  }

  const player = (
    <video
      className="max-h-full w-full bg-black object-contain"
      controls
      playsInline
      poster={coverUrl ?? undefined}
      preload="metadata"
      src={mediaUrl}
      title={displayTitle}
    />
  );

  if (chromeless) {
    return (
      <div className="relative flex h-full w-full items-center justify-center bg-black">
        {player}
        {downloadUrl ? (
          <div className="absolute right-3 top-3 z-10">
            <VideoPresentationExportControls
              downloadUrl={downloadUrl}
              title={displayTitle}
            />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="w-full overflow-hidden rounded-xl border bg-background shadow-sm">
        <div className="grid gap-2 border-b px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <div className="min-w-0 pr-2">
            <p className="whitespace-nowrap text-xs font-medium text-foreground">
              Video Presentation
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {exact.success && exact.data.durationSeconds !== null
                ? `${exact.data.durationSeconds.toFixed(1)}s`
                : "Rendered MP4"}
              {media?.fps ? ` · ${media.fps}fps` : ""}
            </p>
          </div>
          {downloadUrl ? (
            <VideoPresentationExportControls
              downloadUrl={downloadUrl}
              title={displayTitle}
            />
          ) : null}
        </div>
        <div className="flex min-h-64 items-center justify-center bg-black p-2">
          {player}
        </div>
      </div>
    </div>
  );
}
