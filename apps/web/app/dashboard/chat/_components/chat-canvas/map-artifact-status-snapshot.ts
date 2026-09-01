import type { contentClient } from "../../../../../lib/sdk";
import type { ArtifactStatusSnapshot } from "./types";

function resolveArtifactDisplayStatus(
  artifact: Awaited<ReturnType<typeof contentClient.getArtifact>>["artifact"],
): ArtifactStatusSnapshot["status"] {
  const payloadJson = artifact.payloadJson;
  if (
    payloadJson &&
    typeof payloadJson === "object" &&
    !Array.isArray(payloadJson)
  ) {
    const generation = (payloadJson as Record<string, unknown>).generation;
    if (
      generation &&
      typeof generation === "object" &&
      !Array.isArray(generation)
    ) {
      const generationStatus = (generation as Record<string, unknown>).status;
      if (
        generationStatus === "pending" ||
        generationStatus === "running" ||
        generationStatus === "ready" ||
        generationStatus === "failed"
      ) {
        return generationStatus;
      }
      if (generationStatus === "processing") {
        return "running";
      }
    }
  }
  // Backend should keep artifact.status and generation.status in sync; this
  // fallback only covers legacy rows missing a generation block.
  return artifact.status as ArtifactStatusSnapshot["status"];
}

export function mapArtifactStatusSnapshot(
  artifact: Awaited<ReturnType<typeof contentClient.getArtifact>>["artifact"],
): ArtifactStatusSnapshot {
  return {
    artifactType: artifact.artifactType,
    capabilities: artifact.capabilities,
    completedAt: artifact.completedAt,
    createdAt: artifact.createdAt,
    createdBy: artifact.createdBy,
    errorCode: artifact.errorCode,
    errorMessage: artifact.errorMessage,
    id: artifact.id,
    artifactVersionId: artifact.artifactVersionId,
    payloadJson: artifact.payloadJson,
    previewMetadataJson: artifact.previewMetadataJson,
    previewStorageKey: artifact.previewStorageKey,
    previewUrl: artifact.previewUrl,
    promptText: artifact.promptText,
    storageBucket: artifact.storageBucket,
    storageKey: artifact.storageKey,
    status: resolveArtifactDisplayStatus(artifact),
    teamId: artifact.teamId,
    threadId: artifact.threadId,
    title: artifact.title,
    updatedAt: artifact.updatedAt,
    workspaceId: artifact.workspaceId,
  };
}
