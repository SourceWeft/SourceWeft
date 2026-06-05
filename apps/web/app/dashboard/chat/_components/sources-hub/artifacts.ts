import {
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
