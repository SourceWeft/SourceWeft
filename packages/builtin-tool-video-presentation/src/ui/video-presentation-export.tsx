"use client";

import { Video } from "lucide-react";
import { Button } from "@sourceweft/ui-web/components/ui/button";

export function videoPresentationDownloadName(
  title: string,
  extension: "mp4" = "mp4",
) {
  const normalized = title
    .normalize("NFKC")
    .trim()
    // eslint-disable-next-line no-control-regex -- strip filesystem control characters from downloads
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/\s*-\s*/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[\s.-]+|[\s.-]+$/g, "")
    .slice(0, 120);
  const fallback = normalized || "video-presentation";
  return fallback.toLowerCase().endsWith(`.${extension}`)
    ? fallback
    : `${fallback}.${extension}`;
}

export function VideoPresentationExportControls({
  downloadUrl,
  title,
}: {
  downloadUrl: string;
  title: string;
}) {
  return (
    <Button
      asChild
      className="h-7 justify-center gap-1.5 px-3 text-[11px] shadow-sm sm:min-w-32"
      size="xs"
    >
      <a
        download={videoPresentationDownloadName(title)}
        href={downloadUrl}
        rel="noopener"
      >
        <Video className="size-3.5" />
        Download Video
      </a>
    </Button>
  );
}
