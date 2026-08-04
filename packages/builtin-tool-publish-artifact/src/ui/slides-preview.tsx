"use client";

/**
 * Which preview a stored `slides` row gets.
 *
 * This capability publishes more than one shape under one artifact type, so the
 * choice between them is made here rather than by the host: the generic panel
 * asks the owner once and takes whatever it returns.
 *
 * The variants used to be independently-matched renderers tried in array order,
 * all keyed on `artifactType === "slides"`. That ordering is now explicit: the
 * inline renderer is guarded by the same condition it matched on before, and the
 * fallback keeps its own weaker condition (a page URL rather than a proxied file
 * URL) as the last branch. A row that matches neither returns null, exactly as
 * falling off the end of the array did.
 */
import type {
  ArtifactPreviewContext,
  ArtifactPreviewResult,
} from "@sourceweft/contracts/artifact-ui";
import { SLIDES_ARTIFACT_TYPE } from "../artifact-view";
import { SlidesFallback } from "./slides-fallback";
import { PptxViewJsPreview } from "./slides-pptx-preview";

export function slidesPreview(
  context: ArtifactPreviewContext,
): ArtifactPreviewResult | null {
  const { artifact, pageUrl, proxyFileUrl, title } = context;
  if (artifact.artifactType !== SLIDES_ARTIFACT_TYPE) {
    return null;
  }

  const isReady = artifact.status === "ready";

  // 1. `slides-pptx`: ready with a proxied file to draw. On the full-page
  // surface ("page" layout, e.g. the public share page) the deck IS the page,
  // so render edge-to-edge with floating overlay controls + arrow-key paging;
  // in the side panel it stays a self-sized card.
  if (isReady && proxyFileUrl) {
    const immersive = context.layout === "page";
    return {
      id: "slides-pptx",
      content: (
        <PptxViewJsPreview
          className={immersive ? "h-full w-full" : undefined}
          controls={immersive ? "overlay" : "bar"}
          fileUrl={proxyFileUrl}
          fill={immersive}
          title={title}
        />
      ),
    };
  }

  // 2. `slides-fallback`: ready with somewhere to open it, but nothing to draw.
  if (isReady && pageUrl) {
    return { id: "slides-fallback", content: <SlidesFallback /> };
  }

  return null;
}
