import {
  resolveArtifactPreviewImageUrl,
  resolveArtifactPageUrlFromArtifact,
  resolveArtifactProxyFileUrlFromArtifact,
} from "../artifact-urls";
import type { ArtifactListItem } from "./types";

export function artifactTypeLabel(type: ArtifactListItem["artifactType"]) {
  if (type === "audio_overview") return "Audio";
  if (type === "video_overview") return "Video";
  if (type === "video_presentation") return "Video presentation";
  return type
    .replace(/_/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

export function artifactTitle(artifact: ArtifactListItem) {
  return artifact.title?.trim() || artifactTypeLabel(artifact.artifactType);
}

function hasArtifactFile(artifact: ArtifactListItem) {
  return Boolean(artifact.storageKey || artifact.previewUrl);
}

function toRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function artifactPreviewImageMetadata(artifact: ArtifactListItem) {
  const payload = toRecord(artifact.payloadJson);
  const previewImage = toRecord(payload?.previewImage);
  const storageKey =
    typeof previewImage?.storageKey === "string"
      ? previewImage.storageKey.trim()
      : "";
  if (!storageKey) {
    return null;
  }
  return {
    altText:
      typeof previewImage?.altText === "string" &&
      previewImage.altText.trim().length > 0
        ? previewImage.altText.trim()
        : null,
    fileName:
      typeof previewImage?.fileName === "string" &&
      previewImage.fileName.trim().length > 0
        ? previewImage.fileName.trim()
        : "preview.jpg",
    mimeType:
      typeof previewImage?.mimeType === "string"
        ? previewImage.mimeType.trim()
        : "",
    storageKey,
  };
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
  if (!workspaceId || !artifactPreviewImageMetadata(artifact)) {
    return null;
  }
  return resolveArtifactPreviewImageUrl({
    artifactId: artifact.id,
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
  artifact: ArtifactListItem,
  query: string,
) {
  return (
    artifactTitle(artifact).toLowerCase().includes(query) ||
    artifact.artifactType.toLowerCase().includes(query) ||
    artifact.status.toLowerCase().includes(query) ||
    (artifact.promptText ?? "").toLowerCase().includes(query)
  );
}
