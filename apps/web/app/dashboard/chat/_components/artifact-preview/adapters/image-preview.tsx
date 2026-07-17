import { GeneratedImagePreview } from "../../chat-canvas/generated-image-preview";
import type { ArtifactPreviewRenderer } from "../types";

export const imagePreviewRenderer: ArtifactPreviewRenderer = {
  id: "image",
  match: ({ artifact, proxyFileUrl }) =>
    artifact.artifactType === "image" &&
    artifact.status === "ready" &&
    Boolean(proxyFileUrl),
  render: ({ downloadUrl, proxyFileUrl, title }) =>
    proxyFileUrl ? (
      <div className="flex min-h-80 items-center justify-center rounded-xl bg-background p-2">
        <GeneratedImagePreview
          className="w-full [&>span]:mx-auto [&>span]:grid [&>span]:min-h-80 [&>span]:w-full [&>span]:max-w-full [&>span]:place-items-center [&>span>img]:max-h-[calc(100vh-15rem)] [&>span>img]:max-w-full"
          downloadUrl={downloadUrl ?? proxyFileUrl}
          imageUrl={proxyFileUrl}
          title={title}
        />
      </div>
    ) : null,
};
