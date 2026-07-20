"use client";

/**
 * Which preview a stored `slides` row gets.
 *
 * This capability publishes more than one shape under one artifact type, so the
 * choice between them is made here rather than by the host: the generic panel
 * asks the owner once and takes whatever it returns.
 *
 * The three variants used to be three independently-matched renderers tried in
 * array order (visual-html → pptx → fallback), all keyed on
 * `artifactType === "slides"`. That ordering is now explicit: the two inline
 * renderers are guarded by the *same* conditions they matched on before, tried
 * in the same sequence, and the fallback keeps its own weaker condition (a page
 * URL rather than a proxied file URL) as the last branch. A row that matches
 * none of them returns null, exactly as falling off the end of the array did.
 */
import type {
  ArtifactPreviewContext,
  ArtifactPreviewResult,
} from "@sourceweft/contracts/artifact-ui";
import { SLIDES_ARTIFACT_TYPE } from "../artifact-view";
import { SlidesFallback } from "./slides-fallback";
import {
  PptxViewJsPreview,
  resolveSlidesGenerationMode,
} from "./slides-pptx-preview";
import { VisualHtmlDeckPreview } from "./slides-visual-html-preview";

export function slidesPreview(
  context: ArtifactPreviewContext,
): ArtifactPreviewResult | null {
  const { artifact, pageUrl, payload, proxyFileUrl, title } = context;
  if (artifact.artifactType !== SLIDES_ARTIFACT_TYPE) {
    return null;
  }

  const isReady = artifact.status === "ready";

  // 1. `slides-visual-html`: ready, proxied file, and a visual-HTML payload.
  if (isReady && proxyFileUrl && resolveSlidesGenerationMode(payload) === "visual_html") {
    return {
      id: "slides-visual-html",
      content: (
        <VisualHtmlDeckPreview
          payload={payload}
          previewUrl={proxyFileUrl}
          title={title}
        />
      ),
    };
  }

  // 2. `slides-pptx`: ready, proxied file, and an editable-native payload.
  if (
    isReady &&
    proxyFileUrl &&
    resolveSlidesGenerationMode(payload) === "editable_native"
  ) {
    return {
      id: "slides-pptx",
      content: <PptxViewJsPreview fileUrl={proxyFileUrl} title={title} />,
    };
  }

  // 3. `slides-fallback`: ready with somewhere to open it, but nothing to draw.
  if (isReady && pageUrl) {
    return { id: "slides-fallback", content: <SlidesFallback /> };
  }

  return null;
}
