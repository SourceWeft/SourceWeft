import type { ArtifactPreviewContext, ArtifactPreviewRenderer } from "./types";
import { imagePreviewRenderer } from "./adapters/image-preview";
import { slidesPptxPreviewRenderer, slidesFallbackPreviewRenderer } from "./adapters/slides-pptx-preview";
import { slidesVisualHtmlPreviewRenderer } from "./adapters/slides-visual-html-preview";
import { videoFilePreviewRenderer } from "./adapters/video-file-preview";
import { videoPresentationPreviewRenderer } from "./adapters/video-presentation-preview";

export const artifactPreviewRenderers: ArtifactPreviewRenderer[] = [
  videoPresentationPreviewRenderer,
  imagePreviewRenderer,
  videoFilePreviewRenderer,
  slidesVisualHtmlPreviewRenderer,
  slidesPptxPreviewRenderer,
  slidesFallbackPreviewRenderer,
];

export function resolveArtifactPreviewRenderer(
  context: ArtifactPreviewContext,
) {
  return (
    artifactPreviewRenderers.find((renderer) => renderer.match(context)) ?? null
  );
}
