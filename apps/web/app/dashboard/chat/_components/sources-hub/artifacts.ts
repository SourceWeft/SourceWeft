import {
  artifactPreviewImageMetadataFromArtifact,
  resolveArtifactPageUrlFromArtifact,
  resolveArtifactPreviewImageUrlFromArtifact,
  resolveArtifactProxyFileUrlFromArtifact,
} from "../artifact-urls";
import type { ArtifactListItem, ArtifactSummaryItem } from "./types";

type ArtifactIdentity = Pick<ArtifactListItem, "artifactType" | "title">;

/** Types whose name is not their identifier title-cased; worded in every locale. */
const ARTIFACT_TYPE_LABELS = {
  audio_overview: "Audio",
  video_overview: "Video",
  video_presentation: "Video presentation",
  table: "Table",
  flashcards: "Flashcards",
  quiz: "Quiz",
  mindmap: "Mind map",
} as const;

export type LabeledArtifactType = keyof typeof ARTIFACT_TYPE_LABELS;

/** `dashboardSourcesHub` lookup for `artifacts.types.<type>`. */
export type ArtifactTypeTranslate = (
  key: `artifacts.types.${LabeledArtifactType}`,
) => string;

function isLabeledArtifactType(type: string): type is LabeledArtifactType {
  return Object.hasOwn(ARTIFACT_TYPE_LABELS, type);
}

/**
 * The type's display name. With `translate` (the `dashboardSourcesHub`
 * catalog) the labeled types follow the UI locale; without it they are
 * English. Other types are their identifier title-cased.
 */
export function artifactTypeLabel(
  type: ArtifactIdentity["artifactType"],
  translate?: ArtifactTypeTranslate,
) {
  if (isLabeledArtifactType(type)) {
    return translate
      ? translate(`artifacts.types.${type}`)
      : ARTIFACT_TYPE_LABELS[type];
  }
  return type
    .replace(/_/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

export function artifactTitle(artifact: ArtifactIdentity) {
  return artifact.title?.trim() || artifactTypeLabel(artifact.artifactType);
}

function hasArtifactFile(artifact: ArtifactListItem) {
  return Boolean(artifact.storageKey || artifact.previewUrl);
}

export function artifactPreviewImageMetadata(artifact: ArtifactListItem) {
  return artifactPreviewImageMetadataFromArtifact({
    previewMetadataJson: artifact.previewMetadataJson,
    previewStorageKey: artifact.previewStorageKey,
  });
}

function canOpenArtifactFile(artifact: ArtifactListItem) {
  return artifact.capabilities?.canOpenFile ?? hasArtifactFile(artifact);
}

function canPreviewArtifactInline(artifact: ArtifactListItem) {
  return artifact.capabilities?.canPreviewInline ?? hasArtifactFile(artifact);
}

function canDownloadArtifactFile(artifact: ArtifactListItem) {
  return artifact.capabilities?.canDownloadFile ?? hasArtifactFile(artifact);
}

export function resolveArtifactPageUrl(input: {
  artifact: ArtifactListItem;
  workspaceId?: string | null;
}) {
  const { artifact, workspaceId } = input;
  if (!canPreviewArtifactInline(artifact) && !canOpenArtifactFile(artifact)) {
    return null;
  }

  return resolveArtifactPageUrlFromArtifact({
    artifactId: artifact.id,
    artifactVersionId: artifact.artifactVersionId,
    fallbackUrl: artifact.previewUrl,
    workspaceId,
  });
}

export function resolveArtifactProxyFileUrl(input: {
  artifact: ArtifactListItem;
  workspaceId?: string | null;
}) {
  const { artifact, workspaceId } = input;
  if (!canPreviewArtifactInline(artifact) && !canOpenArtifactFile(artifact)) {
    return null;
  }

  return resolveArtifactProxyFileUrlFromArtifact({
    artifactId: artifact.id,
    artifactVersionId: artifact.artifactVersionId,
    fallbackUrl: artifact.previewUrl,
    workspaceId,
  });
}

export function resolveArtifactPreviewImageProxyUrl(input: {
  artifact: ArtifactListItem;
  workspaceId?: string | null;
}) {
  const { artifact, workspaceId } = input;
  return resolveArtifactPreviewImageUrlFromArtifact({
    artifactId: artifact.id,
    artifactVersionId: artifact.artifactVersionId,
    previewMetadataJson: artifact.previewMetadataJson,
    previewStorageKey: artifact.previewStorageKey,
    workspaceId,
  });
}

export function resolveArtifactDownloadUrl(input: {
  artifact: ArtifactListItem;
  workspaceId?: string | null;
}) {
  const { artifact, workspaceId } = input;
  if (!canDownloadArtifactFile(artifact)) {
    return null;
  }

  return resolveArtifactProxyFileUrlFromArtifact({
    artifactId: artifact.id,
    artifactVersionId: artifact.artifactVersionId,
    download: true,
    fallbackUrl: artifact.previewUrl,
    workspaceId,
  });
}

export function artifactMatchesQuery(
  artifact: ArtifactSummaryItem,
  query: string,
) {
  return (
    artifactTitle(artifact).toLowerCase().includes(query) ||
    artifact.artifactType.toLowerCase().includes(query) ||
    artifact.status.toLowerCase().includes(query) ||
    (artifact.promptExcerpt ?? "").toLowerCase().includes(query)
  );
}
