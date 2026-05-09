import { randomUUID } from "node:crypto";
import { ContentError } from "../../errors";
import { dedupeSourceIds } from "../../source-ids";
import {
  collapseSupersededMessages,
  isContextExcludedMessage,
  resolveAgentCheckpointMetadata,
  resolveMentionedSourceIdsFromMessage,
  resolveSkillIdsFromMessage,
  resolveSourceIdsFromMessage,
  resolveWebSearchEnabledFromMessage,
  resolveThreadTurnContext,
} from "../turn/context";
import { normalizeSkillIds } from "../../skills/selection";
import { listMessageRecordsByThread } from "../message-repository";
import type { StreamThreadEventInput } from "../turn/service";
import type { AgentCheckpointRef } from "../turn/types";
import type { EditThreadInput, RefreshThreadInput } from "./types";

async function resolveFallbackEditBaseCheckpoint(input: {
  workspace: Awaited<ReturnType<typeof resolveThreadTurnContext>>["workspace"];
  thread: Awaited<ReturnType<typeof resolveThreadTurnContext>>["thread"];
  latestUserMessageId: string;
}): Promise<AgentCheckpointRef | null> {
  const messages = collapseSupersededMessages(
    await listMessageRecordsByThread({
      teamId: input.workspace.organizationId,
      workspaceId: input.workspace.id,
      threadId: input.thread.id,
    }),
  ).filter((message) => !isContextExcludedMessage(message));

  const userIndex = messages.findIndex(
    (message) => message.id === input.latestUserMessageId,
  );
  if (userIndex < 0) {
    return null;
  }

  for (let index = userIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") {
      continue;
    }

    const checkpoint = resolveAgentCheckpointMetadata(message);
    if (checkpoint?.final) {
      return checkpoint.final;
    }
  }

  return null;
}

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

  const originalMentionedSourceIds =
    resolveMentionedSourceIdsFromMessage(latestUserMessage);
  const originalSourceIds = resolveSourceIdsFromMessage(latestUserMessage);
  const mentionedSourceIds =
    originalMentionedSourceIds.length > 0
      ? originalMentionedSourceIds
      : dedupeSourceIds(input.mentionedSourceIds);
  const sourceIds =
    originalSourceIds.length > 0
      ? originalSourceIds
      : dedupeSourceIds(input.sourceIds);
  const skillIds =
    input.tools !== undefined
      ? normalizeSkillIds(input.tools.skillIds)
      : resolveSkillIdsFromMessage(latestUserMessage);
  const webSearchEnabled =
    input.tools?.webSearchEnabled ??
    resolveWebSearchEnabledFromMessage(latestUserMessage);
  const checkpoint = resolveAgentCheckpointMetadata(latestAssistantMessage);
  const refreshRunThreadId = `thread:${input.threadId}:refresh:${latestUserMessage.id}:${latestAssistantMessage.id}:${input.idempotencyKey ?? randomUUID()}`;

  return {
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    userId: input.userId,
    content: latestUserMessage.content,
    mentionedSourceIds,
    sourceIds,
    tools: { skillIds, webSearchEnabled },
    timezone: input.timezone,
    idempotencyKey: input.idempotencyKey,
    llm: input.llm,
    existingUserMessage: latestUserMessage,
    assistantMessageParentId: latestAssistantMessage.id,
    agentMode: checkpoint?.beforeInput ? "fork" : "continue",
    agentBaseCheckpoint: checkpoint?.beforeInput ?? null,
    agentRunThreadId: refreshRunThreadId,
    failurePersistence: "transient",
  };
}

export async function resolveEditThreadStreamInput(
  input: EditThreadInput,
): Promise<StreamThreadEventInput> {
  const { workspace, thread, latestUserMessage, latestAssistantMessage } =
    await resolveThreadTurnContext(input);

  if (!latestUserMessage) {
    throw new ContentError(
      400,
      "THREAD_EDIT_NOT_AVAILABLE",
      "No user message available to edit",
    );
  }

  const requestedMentionedSourceIds = dedupeSourceIds(input.mentionedSourceIds);
  const mentionedSourceIds =
    requestedMentionedSourceIds.length > 0
      ? requestedMentionedSourceIds
      : resolveMentionedSourceIdsFromMessage(latestUserMessage);
  const requestedSourceIds = dedupeSourceIds(input.sourceIds);
  const sourceIds =
    requestedSourceIds.length > 0
      ? requestedSourceIds
      : resolveSourceIdsFromMessage(latestUserMessage);
  const skillIds =
    input.tools !== undefined
      ? normalizeSkillIds(input.tools.skillIds)
      : resolveSkillIdsFromMessage(latestUserMessage);
  const webSearchEnabled =
    input.tools?.webSearchEnabled ??
    resolveWebSearchEnabledFromMessage(latestUserMessage);
  const checkpoint = resolveAgentCheckpointMetadata(latestAssistantMessage);
  const agentBaseCheckpoint =
    checkpoint?.beforeInput ??
    (await resolveFallbackEditBaseCheckpoint({
      workspace,
      thread,
      latestUserMessageId: latestUserMessage.id,
    }));

  return {
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    userId: input.userId,
    content: input.content,
    mentionedSourceIds,
    sourceIds,
    tools: { skillIds, webSearchEnabled },
    timezone: input.timezone,
    idempotencyKey: input.idempotencyKey,
    llm: input.llm,
    userMessageParentId: latestUserMessage.id,
    assistantMessageParentId: latestAssistantMessage?.id ?? null,
    agentMode: "fork",
    agentBaseCheckpoint,
    agentRunThreadId: `thread:${input.threadId}:edit:${latestUserMessage.id}:${input.idempotencyKey ?? randomUUID()}`,
    failurePersistence: "transient",
  };
}
