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
import { normalizeChatTitle } from "../thread/title";
import { resolveImplicitRefreshInput } from "./context";
import {
  resolveActiveChatProfileByAlias,
  resolveAgentThreadId,
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
  const selectedSourceIds = dedupeSourceIds(input.selectedSourceIds);
  const retrievalSourceIds =
    requestedSourceIds.length > 0 ? requestedSourceIds : selectedSourceIds;

  const implicitRefresh = await resolveImplicitRefreshInput({
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
    threadId: thread.id,
    messageContent,
    sourceIds: retrievalSourceIds,
    existingUserMessage: input.existingUserMessage,
    userMessageParentId: input.userMessageParentId,
    assistantMessageParentId: input.assistantMessageParentId,
  });

  const sourceIds = dedupeSourceIds(implicitRefresh.sourceIds);
  const persistedSelectedSourceIds =
    selectedSourceIds.length > 0 ? selectedSourceIds : sourceIds;
  const existingUserMessage = implicitRefresh.existingUserMessage;
  const assistantMessageParentId = implicitRefresh.assistantMessageParentId;

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
        sourceIds: persistedSelectedSourceIds,
        selectedSourceIds: persistedSelectedSourceIds,
        retrievalSourceIds: sourceIds,
        versionOf: input.userMessageParentId ?? null,
      },
    }));

  const messageRecords = await listMessageRecordsByThread({
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
    threadId: thread.id,
  });
  const isFirstAssistantResponse = !messageRecords.some(
    (message) => message.role === "assistant",
  );
  const initialTitle = thread.title;
  const firstMessageTitle = normalizeChatTitle(messageContent, "New Thread");

  const modelAlias = resolvedChatModel.modelAlias;
  const chatProfile = await resolveActiveChatProfileByAlias(modelAlias);

  const llmIdempotencyKey =
    input.idempotencyKey ||
    (assistantMessageParentId
      ? `thread-refresh:${userMessage.id}:${assistantMessageParentId}:${randomUUID()}`
      : `thread-stream:${userMessage.id}:assistant`);

  const deepAgentThreadId = resolveAgentThreadId({
    threadId: thread.id,
    userMessageParentId: input.userMessageParentId,
    assistantMessageParentId:
      input.agentAssistantMessageParentId ?? assistantMessageParentId,
  });

  return {
    userId: input.userId,
    workspace,
    thread,
    messageContent,
    sourceIds,
    selectedSourceIds: persistedSelectedSourceIds,
    userMessage,
    assistantMessageParentId,
    modelAlias,
    chatProfile,
    llmIdempotencyKey,
    deepAgentThreadId,
    isFirstAssistantResponse,
    initialTitle,
    firstMessageTitle,
  };
}
