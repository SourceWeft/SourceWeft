// Maps a capability's renderAs to the component that renders its finished
// artifact. Generic render code dispatches here instead of branching on
// capability tags or per-medium block types.
import type { ComponentType } from "react";
import {
  GeneratedImageArtifactBlock,
  GeneratedPresentationArtifactBlock,
} from "./reasoning-trace";
import type {
  ArtifactPreviewRecord,
  ArtifactStatusSnapshot,
  ToolCallRecord,
} from "./types";

export type ArtifactBlockProps = {
  toolCall: ToolCallRecord | undefined;
  workspaceId?: string | null;
  artifactStatuses?: ReadonlyMap<string, ArtifactStatusSnapshot>;
  onArtifactPreview?: (artifact: ArtifactPreviewRecord) => void;
};

// The presentation body derives slide-vs-video internally from the toolCall
// capability, so a single component faithfully serves both "pptx" and "video".
const REGISTRY: Record<string, ComponentType<ArtifactBlockProps>> = {
  image: GeneratedImageArtifactBlock,
  pptx: GeneratedPresentationArtifactBlock,
  video: GeneratedPresentationArtifactBlock,
};

export function getArtifactBlockRenderer(
  renderAs: string | null,
): ComponentType<ArtifactBlockProps> | null {
  return renderAs ? (REGISTRY[renderAs] ?? null) : null;
}
