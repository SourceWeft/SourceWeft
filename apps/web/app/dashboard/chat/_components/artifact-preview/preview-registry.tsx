// Capabilities that own their artifact UI are asked first, keyed by the
// artifactType they claim — no payload sniffing and no ordering rule on this
// side. What remains below is the generic medium fallback: a renderer that keys
// off a stored file's MIME type rather than off any capability's vocabulary,
// and so belongs to the app rather than to a package.
import { resolveArtifactPreview } from "@sourceweft/agent-tool-registry/ui";
import type { ArtifactPreviewContext, ArtifactPreviewRenderer } from "./types";
import "../artifact-render-host";
import { videoFilePreviewRenderer } from "./adapters/video-file-preview";

export const artifactPreviewRenderers: ArtifactPreviewRenderer[] = [
  videoFilePreviewRenderer,
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

  return (
    artifactPreviewRenderers.find((renderer) => renderer.match(context)) ?? null
  );
}
