import {
  artifactPreviewImageMetadataFromArtifact,
  resolveArtifactPageUrlFromArtifact,
  resolveArtifactPreviewImageUrlFromArtifact,
  resolveArtifactProxyFileUrlFromArtifact,
} from "../artifact-urls";
import type { ArtifactListItem, ArtifactSummaryItem } from "./types";

type ArtifactIdentity = Pick<ArtifactListItem, "artifactType" | "title">;

export function artifactTypeLabel(type: ArtifactIdentity["artifactType"]) {
  if (type === "audio_overview") return "Audio";
  if (type === "video_overview") return "Video";
  if (type === "video_presentation") return "Video presentation";
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
