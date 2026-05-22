import { randomUUID } from "node:crypto";
import { ContentError } from "../../errors";
import { dedupeSourceIds } from "../../source-ids";
import {
  collapseSupersededMessages,
  isContextExcludedMessage,
  resolveAgentCheckpointMetadata,
  resolveGenerateImageToolFromMessage,
  resolveMentionedSourceIdsFromMessage,
  resolveMcpToolSelectionFromMessage,
  resolveNotionToolSelectionsFromMessage,
  resolveSkillIdsFromMessage,
  resolveSourceIdsFromMessage,
  resolveWebSearchEnabledFromMessage,
  resolveThreadTurnContext,
} from "../turn/context";
import { normalizeSkillIds } from "../../skills/selection";
import { AGENT_TOOL_NAMES } from "../../agent/tool-names";
import {
  buildThreadToolsMetadata,
  resolveMcpToolSelection,
  resolveNotionToolSelections,
} from "../turn/tool-selection";
import { listMessageRecordsByThread } from "../message-repository";
import type { StreamThreadEventInput } from "../turn/service";
import type { AgentCheckpointRef, ChatMessageImagePart } from "../turn/types";
import type { EditThreadInput, RefreshThreadInput } from "./types";

function extractImagePartsFromContentJson(value: unknown) {
  const contentJson =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as { parts?: unknown })
      : {};
  if (!Array.isArray(contentJson.parts)) {
    return [] as ChatMessageImagePart[];
  }

  return contentJson.parts
    .map((part): ChatMessageImagePart | null => {
      if (!part || typeof part !== "object" || Array.isArray(part)) {
        return null;
      }
      const record = part as Record<string, unknown>;
      if (
        record.type !== "image" ||
        typeof record.id !== "string" ||
        typeof record.fileName !== "string" ||
        typeof record.mimeType !== "string" ||
        typeof record.storageKey !== "string" ||
        typeof record.url !== "string"
      ) {
        return null;
      }
      return {
        type: "image" as const,
        id: record.id,
        fileName: record.fileName,
        mimeType: record.mimeType,
        sizeBytes:
          typeof record.sizeBytes === "number" &&
          Number.isFinite(record.sizeBytes)
            ? record.sizeBytes
            : 0,
        width:
          typeof record.width === "number" && Number.isFinite(record.width)
            ? record.width
            : null,
        height:
          typeof record.height === "number" && Number.isFinite(record.height)
            ? record.height
            : null,
        storageBucket:
          typeof record.storageBucket === "string"
            ? record.storageBucket
            : null,
        storageKey: record.storageKey,
        url: record.url,
        ...(typeof record.visionDescription === "string"
          ? { visionDescription: record.visionDescription }
          : {}),
        ...(typeof record.visionModelAlias === "string"
          ? { visionModelAlias: record.visionModelAlias }
          : {}),
        ...(typeof record.visionProfileAlias === "string"
          ? { visionProfileAlias: record.visionProfileAlias }
          : {}),
      };
    })
    .filter((part): part is ChatMessageImagePart => part !== null);
}

function shouldUseSubmittedEditImages(input: {
  images?: EditThreadInput["images"];
  imagesProvided?: boolean;
}) {
  return input.imagesProvided === true;
}

function getMessageMetadataRecord(message: {
  metadata?: unknown;
}): Record<string, unknown> {
  return message.metadata &&
    typeof message.metadata === "object" &&
    !Array.isArray(message.metadata)
    ? (message.metadata as Record<string, unknown>)
    : {};
}

function resolveToolConfirmationRefreshAgentState(input: {
  checkpoint: ReturnType<typeof resolveAgentCheckpointMetadata>;
  finishReason?: unknown;
  toolApprovalResume?: RefreshThreadInput["toolApprovalResume"];
}) {
  if (input.finishReason !== "tool_confirmation_requested") {
    return {
      agentBaseCheckpoint: input.checkpoint?.beforeInput ?? null,
      agentMode: input.checkpoint?.beforeInput ? "fork" : "continue",
    } as const;
  }

  const resumeCheckpoint =
    input.checkpoint?.resume ??
    input.checkpoint?.beforeAssistant ??
    input.checkpoint?.final ??
    null;

  if (!input.toolApprovalResume) {
    throw new ContentError(
      400,
      "THREAD_CONFIRMATION_RESUME_REQUIRED",
      "Tool confirmation refresh requires a DeepAgents resume decision payload.",
    );
  }

  if (!resumeCheckpoint) {
    throw new ContentError(
      409,
      "THREAD_CONFIRMATION_CHECKPOINT_MISSING",
      "Tool confirmation checkpoint is missing.",
    );
  }

  return {
    agentBaseCheckpoint: resumeCheckpoint,
    agentMode: "replay",
  } as const;
}

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
    input.tools?.[AGENT_TOOL_NAMES.webSearch]?.enabled ??
    input.tools?.webSearchEnabled ??
    resolveWebSearchEnabledFromMessage(latestUserMessage);
  const generateImageTool =
    input.tools?.[AGENT_TOOL_NAMES.generateImage] ??
    resolveGenerateImageToolFromMessage(latestUserMessage);
  const notionTools =
    input.tools !== undefined
      ? resolveNotionToolSelections(input.tools)
      : resolveNotionToolSelectionsFromMessage(latestUserMessage);
  const mcpTools =
    input.tools !== undefined
      ? resolveMcpToolSelection(input.tools)
      : resolveMcpToolSelectionFromMessage(latestUserMessage);
  const checkpoint = resolveAgentCheckpointMetadata(latestAssistantMessage);
  const refreshRunThreadId = `thread:${input.threadId}:refresh:${latestUserMessage.id}:${latestAssistantMessage.id}:${input.idempotencyKey ?? randomUUID()}`;
  const latestAssistantMetadata =
    getMessageMetadataRecord(latestAssistantMessage);
  const isToolApprovalContinuation = Boolean(
    input.toolApprovalResume && input.assistantMessageId,
  );
  const refreshAgentState = resolveToolConfirmationRefreshAgentState({
    checkpoint,
    finishReason: latestAssistantMetadata.finishReason,
    toolApprovalResume: input.toolApprovalResume,
  });

  return {
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    userId: input.userId,
    content: latestUserMessage.content,
    existingImageParts: extractImagePartsFromContentJson(
      latestUserMessage.contentJson,
    ),
    mentionedSourceIds,
    sourceIds,
    tools: buildThreadToolsMetadata({
      skillIds,
      webSearchEnabled,
      generateImageTool,
      notionTools,
      mcpTools,
    }),
    command: input.command,
    timezone: input.timezone,
    idempotencyKey: input.idempotencyKey,
    llm: input.llm,
    image: input.image,
    vision: input.vision,
    visionProfileAlias: input.visionProfileAlias,
    existingUserMessage: latestUserMessage,
    assistantMessageParentId: isToolApprovalContinuation
      ? latestAssistantMessage.parentMessageId
      : latestAssistantMessage.id,
    assistantMessageId:
      isToolApprovalContinuation ? input.assistantMessageId! : null,
    agentMode: refreshAgentState.agentMode,
    agentBaseCheckpoint: refreshAgentState.agentBaseCheckpoint,
    agentRunThreadId: refreshRunThreadId,
    toolApprovalResume: input.toolApprovalResume ?? null,
    failurePersistence: "persist-error-turn",
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
    input.tools?.[AGENT_TOOL_NAMES.webSearch]?.enabled ??
    input.tools?.webSearchEnabled ??
    resolveWebSearchEnabledFromMessage(latestUserMessage);
  const generateImageTool =
    input.tools?.[AGENT_TOOL_NAMES.generateImage] ??
    resolveGenerateImageToolFromMessage(latestUserMessage);
  const notionTools =
    input.tools !== undefined
      ? resolveNotionToolSelections(input.tools)
      : resolveNotionToolSelectionsFromMessage(latestUserMessage);
  const mcpTools =
    input.tools !== undefined
      ? resolveMcpToolSelection(input.tools)
      : resolveMcpToolSelectionFromMessage(latestUserMessage);
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
    ...(shouldUseSubmittedEditImages(input)
      ? { images: input.images }
      : {}),
    existingImageParts:
      !shouldUseSubmittedEditImages(input)
        ? extractImagePartsFromContentJson(latestUserMessage.contentJson)
        : undefined,
    mentionedSourceIds,
    sourceIds,
    tools: buildThreadToolsMetadata({
      skillIds,
      webSearchEnabled,
      generateImageTool,
      notionTools,
      mcpTools,
    }),
    command: input.command,
    timezone: input.timezone,
    idempotencyKey: input.idempotencyKey,
    llm: input.llm,
    image: input.image,
    vision: input.vision,
    visionProfileAlias: input.visionProfileAlias,
    userMessageParentId: latestUserMessage.id,
    assistantMessageParentId: latestAssistantMessage?.id ?? null,
    agentMode: "fork",
    agentBaseCheckpoint,
    agentRunThreadId: `thread:${input.threadId}:edit:${latestUserMessage.id}:${input.idempotencyKey ?? randomUUID()}`,
    failurePersistence: "persist-error-turn",
  };
}

export const testExports = {
  getMessageMetadataRecord,
  resolveToolConfirmationRefreshAgentState,
  shouldUseSubmittedEditImages,
};
