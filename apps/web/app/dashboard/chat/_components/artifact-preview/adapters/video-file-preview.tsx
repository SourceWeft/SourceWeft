import { Video } from "lucide-react";
import type { ArtifactPreviewRenderer } from "../types";
import { payloadString } from "../utils";

function isVideoFileArtifact(input: {
  artifactType: string;
  payload: Record<string, unknown>;
}) {
  return (
    input.artifactType === "video_overview" ||
    payloadString(input.payload, "mimeType")?.startsWith("video/") === true
  );
}

function VideoFilePreview({
  fileUrl,
  title,
}: {
  fileUrl: string;
  title: string;
}) {
  return (
    <div className="overflow-hidden rounded-xl border bg-background shadow-sm">
      <div className="flex items-center gap-2 border-b px-3 py-2.5">
        <Video className="size-3.5 text-muted-foreground" />
        <p className="truncate text-xs font-medium text-foreground">
          Video Preview
        </p>
      </div>
      <div className="bg-[#0b1017] p-2">
        <video
          className="mx-auto max-h-[calc(100vh-12rem)] w-full rounded-lg bg-black"
          controls
          playsInline
          preload="metadata"
          src={fileUrl}
          title={title}
        />
      </div>
    </div>
  );
}

export const videoFilePreviewRenderer: ArtifactPreviewRenderer = {
  id: "video-file",
  match: ({ artifact, payload, proxyFileUrl }) =>
    artifact.status === "ready" &&
    Boolean(proxyFileUrl) &&
    artifact.artifactType !== "video_presentation" &&
    isVideoFileArtifact({ artifactType: artifact.artifactType, payload }),
  render: ({ proxyFileUrl, title }) =>
    proxyFileUrl ? <VideoFilePreview fileUrl={proxyFileUrl} title={title} /> : null,
};
