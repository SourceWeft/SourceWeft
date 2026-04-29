import { randomUUID } from "node:crypto";
import { ContentError } from "../../errors";
import { dedupeSourceIds } from "../../source-ids";
import { requireContentWorkspace } from "../../content-support";
import {
  findThreadRecord,
  updateThreadModelSettingsRecord,
} from "../thread/repository";
import {
  createMessageRecord,
  listMessageRecordsByThread,
} from "../message-repository";
import {
  mergeThreadModelSettings,
  normalizeThreadModelSettings,
} from "../model-settings";
import {
  collapseSupersededMessages,
  isContextExcludedMessage,
  resolveAgentCheckpointMetadata,
  resolveSourceIdsFromMessage,
} from "./context";
import {
  resolveActiveChatProfileByAlias,
  resolveThreadChatModelAlias,
} from "./model-resolution";
import { assertSourcesExist } from "./source-validation";
import type { PreparedThreadTurn, StreamThreadEventInput } from "./types";

export async function prepareThreadTurn(
  input: StreamThreadEventInput,
): Promise<PreparedThreadTurn> {
  const messageContent =
    input.existingUserMessage?.content.trim() ?? input.content.trim();
  if (!messageContent) {
    throw new ContentError(
      400,
      "EMPTY_MESSAGE",
      "content is required for thread stream",
    );
  }

  const workspace = await requireContentWorkspace({
    workspaceId: input.workspaceId,
    userId: input.userId,
  });

  let thread = await findThreadRecord({
    threadId: input.threadId,
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
  });

  if (!thread) {
    throw new ContentError(404, "THREAD_NOT_FOUND", "Thread not found");
  }

  const requestedModelAlias =
    typeof input.llm?.modelAlias === "string" ? input.llm.modelAlias.trim() : "";

  const resolvedChatModel = await resolveThreadChatModelAlias({
    threadModelSettings: normalizeThreadModelSettings(thread.modelSettings),
    requestedModelAlias: requestedModelAlias || undefined,
  });

  if (
    requestedModelAlias.length > 0 &&
    thread.modelSettings.llmModelAlias !== requestedModelAlias
  ) {
    const updatedThread = await updateThreadModelSettingsRecord({
      threadId: thread.id,
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      modelSettings: mergeThreadModelSettings(
        normalizeThreadModelSettings(thread.modelSettings),
        { llmModelAlias: requestedModelAlias },
      ),
    });
    if (updatedThread) {
      thread = updatedThread;
    }
  }

  const requestedSourceIds = dedupeSourceIds(input.sourceIds);
  const existingUserMessage = input.existingUserMessage;
  const assistantMessageParentId = input.assistantMessageParentId ?? null;
  const messageRecords = await listMessageRecordsByThread({
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
    threadId: thread.id,
  });

  const fallbackSourceIds = resolveLatestSourceIds(messageRecords);
  const sourceIds = requestedSourceIds.length > 0
    ? requestedSourceIds
    : fallbackSourceIds;

  await assertSourcesExist({
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
    sourceIds,
  });

  const userMessage =
    existingUserMessage ??
    (await createMessageRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      threadId: thread.id,
      parentMessageId: input.userMessageParentId ?? null,
      role: "user",
      content: messageContent,
      createdBy: input.userId,
      metadata: {
        source: "api",
        sourceIds,
        versionOf: input.userMessageParentId ?? null,
      },
    }));

  const isFirstAssistantResponse = !messageRecords.some(
    (message) => message.role === "assistant",
  );
  const initialTitle = thread.title;

  const modelAlias = resolvedChatModel.modelAlias;
  const chatProfile = await resolveActiveChatProfileByAlias(modelAlias);
  const agentMode = input.agentMode ?? "continue";
  const latestAssistantCheckpoint = agentMode === "continue"
    ? resolveLatestAssistantFinalCheckpoint(messageRecords)
    : null;
  const agentBaseCheckpoint = input.agentBaseCheckpoint ?? latestAssistantCheckpoint;

  const llmIdempotencyKey =
    input.idempotencyKey ||
    (assistantMessageParentId
        ? `thread-refresh:${userMessage.id}:${assistantMessageParentId}:${randomUUID()}`
        : `thread-stream:${userMessage.id}:assistant`);

  const agentRunThreadId = input.agentRunThreadId ?? thread.id;

  return {
    userId: input.userId,
    workspace,
    thread,
    messageContent,
    sourceIds,
    userMessage,
    assistantMessageParentId,
    modelAlias,
    chatProfile,
    llmIdempotencyKey,
    agentMode,
    agentBaseCheckpoint,
    agentRunThreadId,
    isFirstAssistantResponse,
    initialTitle,
  };
}

function resolveLatestSourceIds(messageRecords: Awaited<ReturnType<typeof listMessageRecordsByThread>>) {
  const messages = collapseSupersededMessages(messageRecords)
    .filter((message) => !isContextExcludedMessage(message));

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") {
      continue;
    }

    const sourceIds = resolveSourceIdsFromMessage(message);
    if (sourceIds.length > 0) {
      return sourceIds;
    }
  }

  return [] as string[];
}

function resolveLatestAssistantFinalCheckpoint(messageRecords: Awaited<ReturnType<typeof listMessageRecordsByThread>>) {
  const messages = collapseSupersededMessages(messageRecords)
    .filter((message) => !isContextExcludedMessage(message));

  for (let index = messages.length - 1; index >= 0; index -= 1) {
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
