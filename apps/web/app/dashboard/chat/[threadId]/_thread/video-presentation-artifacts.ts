import { hasAgentToolCapability } from "@sourceweft/agent-tool-registry";
import { getToolOutputField } from "../../_components/chat-canvas/message-assets";
import type { ArtifactStatusSnapshot } from "../../_components/chat-canvas";
import type { contentClient } from "../../../../../lib/sdk";
import { resolveToolCallsFromMetadata } from "./message-normalizers";

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
    payloadJson: artifact.payloadJson,
    previewMetadataJson: artifact.previewMetadataJson,
    previewStorageKey: artifact.previewStorageKey,
    previewUrl: artifact.previewUrl,
    promptText: artifact.promptText,
    storageBucket: artifact.storageBucket,
    storageKey: artifact.storageKey,
    status: artifact.status,
    teamId: artifact.teamId,
    threadId: artifact.threadId,
    title: artifact.title,
    updatedAt: artifact.updatedAt,
    workspaceId: artifact.workspaceId,
  };
}

export function collectPendingVideoPresentationArtifactIds(
  messages: Array<{ metadata: Record<string, unknown> }>,
) {
  const ids = new Set<string>();

  for (const message of messages) {
    for (const toolCall of resolveToolCallsFromMetadata(message.metadata)) {
      if (
        !hasAgentToolCapability(toolCall.tool, "video_presentation_artifact")
      ) {
        continue;
      }
      const outputType = getToolOutputField(toolCall.output, "type");
      if (
        outputType !== "video_presentation_artifact_result" &&
        outputType !== "video_presentation_processing_result" &&
        outputType !== "generate_video_presentation_progress"
      ) {
        continue;
      }
      const artifactId = getToolOutputField(toolCall.output, "artifact_id");
      if (artifactId) {
        ids.add(artifactId);
      }
    }
  }

  return [...ids];
}
