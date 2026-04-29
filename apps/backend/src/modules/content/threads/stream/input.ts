import { randomUUID } from "node:crypto";
import { ContentError } from "../../errors";
import { dedupeSourceIds } from "../../source-ids";
import {
  resolveAgentCheckpointMetadata,
  resolveSourceIdsFromMessage,
  resolveThreadTurnContext,
} from "../turn/context";
import type { StreamThreadEventInput } from "../turn/service";
import type { EditThreadInput, RefreshThreadInput } from "./types";

export async function resolveRefreshThreadStreamInput(
  input: RefreshThreadInput,
): Promise<StreamThreadEventInput> {
  const { latestUserMessage, latestAssistantMessage } =
    await resolveThreadTurnContext(input);

  if (!latestUserMessage || !latestAssistantMessage) {
    throw new ContentError(
      400,
      "THREAD_REFRESH_NOT_AVAILABLE",
      "No completed assistant response available to refresh",
    );
  }

  const originalSourceIds = resolveSourceIdsFromMessage(latestUserMessage);
  const sourceIds = originalSourceIds.length > 0
    ? originalSourceIds
    : dedupeSourceIds(input.sourceIds);
  const checkpoint = resolveAgentCheckpointMetadata(latestAssistantMessage);
  if (!checkpoint?.beforeAssistant) {
    throw new ContentError(
      409,
      "THREAD_CHECKPOINT_NOT_AVAILABLE",
      "The assistant response is missing checkpoint metadata and cannot be refreshed",
    );
  }

  return {
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    userId: input.userId,
    content: latestUserMessage.content,
    sourceIds,
    idempotencyKey: input.idempotencyKey,
    llm: input.llm,
    existingUserMessage: latestUserMessage,
    assistantMessageParentId: latestAssistantMessage.id,
    agentMode: "replay",
    agentBaseCheckpoint: checkpoint.beforeAssistant,
    agentRunThreadId: `thread:${input.threadId}:refresh:${latestUserMessage.id}:${latestAssistantMessage.id}:${input.idempotencyKey ?? randomUUID()}`,
  };
}

export async function resolveEditThreadStreamInput(
  input: EditThreadInput,
): Promise<StreamThreadEventInput> {
  const { latestUserMessage, latestAssistantMessage } =
    await resolveThreadTurnContext(input);

  if (!latestUserMessage) {
    throw new ContentError(
      400,
      "THREAD_EDIT_NOT_AVAILABLE",
      "No user message available to edit",
    );
  }

  const requestedSourceIds = dedupeSourceIds(input.sourceIds);
  const sourceIds = requestedSourceIds.length > 0
    ? requestedSourceIds
    : resolveSourceIdsFromMessage(latestUserMessage);
  const checkpoint = resolveAgentCheckpointMetadata(latestAssistantMessage);
  if (!checkpoint) {
    throw new ContentError(
      409,
      "THREAD_CHECKPOINT_NOT_AVAILABLE",
      "The assistant response is missing checkpoint metadata and cannot be edited",
    );
  }

  return {
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    userId: input.userId,
    content: input.content,
    sourceIds,
    idempotencyKey: input.idempotencyKey,
    llm: input.llm,
    userMessageParentId: latestUserMessage.id,
    assistantMessageParentId: latestAssistantMessage?.id ?? null,
    agentMode: "fork",
    agentBaseCheckpoint: checkpoint.beforeInput,
    agentRunThreadId: `thread:${input.threadId}:edit:${latestUserMessage.id}:${input.idempotencyKey ?? randomUUID()}`,
  };
}
