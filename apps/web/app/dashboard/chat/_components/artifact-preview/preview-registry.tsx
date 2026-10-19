// Capabilities that own their artifact UI are asked first, keyed by the
// artifactType they claim — no payload sniffing and no ordering rule on this
// side. What remains below is the generic medium fallback: a renderer that keys
// off a stored file's MIME type rather than off any capability's vocabulary,
// and so belongs to the app rather than to a package.
import { resolveArtifactPreview } from "@sourceweft/agent-tool-registry/ui";
import type { ArtifactPreviewContext, ArtifactPreviewRenderer } from "./types";
import "../artifact-render-host";
import { videoFilePreviewRenderer } from "./adapters/video-file-preview";
import {
  ArtifactFileDownloads,
  artifactDownloadFiles,
  artifactPrimaryPreviewFile,
} from "@sourceweft/builtin-tool-publish-artifact/ui";
import { Preview } from "@sourceweft/preview/react";

export const artifactPreviewRenderers: ArtifactPreviewRenderer[] = [
  videoFilePreviewRenderer,
  {
    id: "file-preview",
    match: ({ artifact, proxyFileUrl }) =>
      artifact.status === "ready" && Boolean(proxyFileUrl),
    render: ({ artifact, proxyFileUrl, title, payload }) => {
      const primary = artifactPrimaryPreviewFile(payload.versionFiles);
      return (
        <div className="flex h-full min-h-0 flex-col">
          <ArtifactFileDownloads files={payload.versionFiles} />
          <div className="min-h-0 flex-1">
            <Preview
              source={{
                url: proxyFileUrl!,
                name:
                  primary?.fileName ??
                  (artifact.storageKey?.split("/").pop() || title),
                mimeType: primary?.contentType,
              }}
            />
          </div>
        </div>
      );
    },
  },
];

export function resolveArtifactPreviewRenderer(
  context: ArtifactPreviewContext,
): ArtifactPreviewRenderer | null {
  const owned = resolveArtifactPreview(context);
  if (owned) {
    // The capability already picked the variant and produced the node; adapt it
    // to the panel's renderer shape without letting anything decide again.
    return {
      blocksDefaultDownload: owned.blocksDefaultDownload,
      blocksDefaultOpen: owned.blocksDefaultOpen,
      id: owned.id,
      match: () => true,
      render: () => owned.content,
    };
  }

  const fallback = artifactPreviewRenderers.find((renderer) =>
    renderer.match(context),
  );
  if (!fallback) return null;
  return {
    ...fallback,
    blocksDefaultDownload:
      fallback.id === "file-preview" &&
      artifactDownloadFiles(context.payload.versionFiles).length > 0,
  };
}
