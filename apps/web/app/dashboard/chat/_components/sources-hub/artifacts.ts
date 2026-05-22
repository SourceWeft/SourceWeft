import { apiBaseUrl } from "../../../../../lib/sdk";
import type { ArtifactListItem } from "./types";

export function artifactTypeLabel(type: ArtifactListItem["artifactType"]) {
  if (type === "audio_overview") return "Audio";
  if (type === "video_overview") return "Video";
  return type
    .replace(/_/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

export function artifactTitle(artifact: ArtifactListItem) {
  return artifact.title?.trim() || artifactTypeLabel(artifact.artifactType);
}

export function resolveArtifactFileUrl(input: {
  artifact: ArtifactListItem;
  workspaceId?: string | null;
}) {
  const { artifact, workspaceId } = input;

  if (artifact.previewUrl) {
    return artifact.previewUrl.startsWith("/v1/")
      ? `${apiBaseUrl}${artifact.previewUrl}`
      : artifact.previewUrl;
  }

  if (workspaceId && artifact.storageKey) {
    return `${apiBaseUrl}/v1/workspaces/${encodeURIComponent(workspaceId)}/artifacts/${encodeURIComponent(artifact.id)}/file`;
  }

  return null;
}

export function resolveArtifactDownloadUrl(input: {
  artifact: ArtifactListItem;
  workspaceId?: string | null;
}) {
  const { artifact, workspaceId } = input;
  if (!workspaceId || !artifact.storageKey) {
    return null;
  }

  return `${apiBaseUrl}/v1/workspaces/${encodeURIComponent(workspaceId)}/artifacts/${encodeURIComponent(artifact.id)}/download`;
}

export function artifactMatchesQuery(artifact: ArtifactListItem, query: string) {
  return (
    artifactTitle(artifact).toLowerCase().includes(query) ||
    artifact.artifactType.toLowerCase().includes(query) ||
    artifact.status.toLowerCase().includes(query) ||
    (artifact.promptText ?? "").toLowerCase().includes(query)
  );
}
