import { randomUUID } from "node:crypto";
import type { ToolApprovalResume } from "@sourceweft/contracts";
import { ContentError } from "../../errors";
import { dedupeSourceIds } from "../../source-ids";
import {
  collapseSupersededMessages,
  filterMessagesBeforeEditAnchor,
  isContextExcludedMessage,
  resolveAgentCheckpointMetadata,
  resolveGenerateImageToolFromMessage,
  resolveGeneratePptxToolFromMessage,
  resolveGenerateVideoPresentationToolFromMessage,
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
  resolveGeneratePptxToolSelection,
  resolveGenerateVideoPresentationToolSelection,
  resolveMcpToolSelection,
  resolveNotionToolSelections,
} from "../turn/tool-selection";
import { listMessageRecordsByThread } from "../message-repository";
import type { StreamThreadEventInput } from "../turn/service";
import type {
  AgentCheckpointMetadata,
  AgentCheckpointRef,
  ChatMessageImagePart,
} from "../turn/types";
import type {
  EditThreadInput,
  RefreshThreadInput,
  ResumeThreadInput,
} from "./types";

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

function getObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getStringField(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function resolveToolConfirmationResumeCheckpoint(
  checkpoint: AgentCheckpointMetadata | null,
) {
  const resumeCheckpoint =
    checkpoint?.resume ?? checkpoint?.beforeAssistant ?? checkpoint?.final ?? null;

  if (!resumeCheckpoint) {
    throw new ContentError(
      409,
      "THREAD_CONFIRMATION_CHECKPOINT_MISSING",
      "Tool confirmation checkpoint is missing.",
    );
  }

  return resumeCheckpoint;
}

type ConnectorActionResumeRef = NonNullable<
  NonNullable<ToolApprovalResume["sourceweft"]>["connectorActions"]
>[number];

function extractApprovedConnectorActionsFromMessage(message: {
  metadata?: unknown;
}): ConnectorActionResumeRef[] {
  const metadata = getMessageMetadataRecord(message);
  const toolCalls = Array.isArray(metadata.toolCalls)
    ? metadata.toolCalls
    : [];
  const actions: ConnectorActionResumeRef[] = [];

  for (const toolCall of toolCalls) {
    const toolCallRecord = getObjectRecord(toolCall);
    const output = getObjectRecord(toolCallRecord?.output);
    if (
      output?.type !== "tool_confirmation_request" ||
      output.status !== "approved"
    ) {
      continue;
    }

    const action = getObjectRecord(output.action);
    const execution = getObjectRecord(output.execution);
    const executor = getObjectRecord(execution?.executor);
    if (executor?.kind !== "connector_action_run") {
      continue;
    }

    const connectorId = getStringField(executor, "connectorId");
    const actionRunId = getStringField(executor, "actionRunId");
    const toolName =
      getStringField(action, "toolName") ??
      getStringField(toolCallRecord, "tool");
    if (!connectorId || !actionRunId || !toolName) {
      continue;
    }

    const preview = getObjectRecord(output.preview);
    const requestJson = getObjectRecord(preview?.requestJson);
    actions.push({
      actionRunId,
      connectorId,
      toolName,
      ...(requestJson ? { requestJson } : {}),
    });
  }

  return actions;
}

function mergeToolApprovalResumeConnectorActions(input: {
  priorConnectorActions: ConnectorActionResumeRef[];
  resume: ToolApprovalResume;
}): ToolApprovalResume {
  const existingActions = input.resume.sourceweft?.connectorActions ?? [];
  const mergedActions: ConnectorActionResumeRef[] = [];
  const seen = new Set<string>();

  for (const action of [
    ...input.priorConnectorActions,
    ...existingActions,
  ]) {
    const key = `${action.connectorId}:${action.actionRunId}:${action.toolName}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    mergedActions.push(action);
  }

  if (mergedActions.length === 0 && !input.resume.sourceweft?.hitlInterruptId) {
    return input.resume;
  }

  return {
    ...input.resume,
    sourceweft: {
      ...(input.resume.sourceweft ?? {}),
      ...(mergedActions.length > 0 ? { connectorActions: mergedActions } : {}),
    },
  };
}

async function resolveFallbackEditBaseCheckpoint(input: {
  workspace: Awaited<ReturnType<typeof resolveThreadTurnContext>>["workspace"];
  thread: Awaited<ReturnType<typeof resolveThreadTurnContext>>["thread"];
  latestUserMessageId: string;
}): Promise<AgentCheckpointRef | null> {
  return resolveEditBaseCheckpointFromMessages({
    latestUserMessageId: input.latestUserMessageId,
    messages: await listMessageRecordsByThread({
      teamId: input.workspace.organizationId,
      workspaceId: input.workspace.id,
      threadId: input.thread.id,
    }),
  });
}

function resolveEditBaseCheckpointFromMessages(input: {
  latestUserMessageId: string;
  messages: Awaited<ReturnType<typeof listMessageRecordsByThread>>;
}): AgentCheckpointRef | null {
  const messages = collapseSupersededMessages(
    filterMessagesBeforeEditAnchor({
      anchorUserMessageId: input.latestUserMessageId,
      messages: input.messages,
    }),
  ).filter((message) => !isContextExcludedMessage(message));

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
  const generatePptxTool =
    input.tools !== undefined
      ? resolveGeneratePptxToolSelection(input.tools)
      : resolveGeneratePptxToolFromMessage(latestUserMessage);
  const generateVideoPresentationTool =
    input.tools !== undefined
      ? resolveGenerateVideoPresentationToolSelection(input.tools)
      : resolveGenerateVideoPresentationToolFromMessage(latestUserMessage);
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
      generatePptxTool,
      generateVideoPresentationTool,
      notionTools,
      mcpTools,
    }),
    command: input.command,
    invocation: input.invocation,
    timezone: input.timezone,
    idempotencyKey: input.idempotencyKey,
    llm: input.llm,
    image: input.image,
    vision: input.vision,
    visionProfileAlias: input.visionProfileAlias,
    existingUserMessage: latestUserMessage,
    assistantMessageParentId: latestAssistantMessage.id,
    assistantMessageId: null,
    agentMode: checkpoint?.beforeInput ? "fork" : "continue",
    agentBaseCheckpoint: checkpoint?.beforeInput ?? null,
    agentRunThreadId: refreshRunThreadId,
    toolApprovalResume: null,
    failurePersistence: "persist-error-turn",
  };
}

export async function resolveResumeThreadStreamInput(
  input: ResumeThreadInput,
): Promise<StreamThreadEventInput> {
  const { latestUserMessage, latestAssistantMessage } =
    await resolveThreadTurnContext({
      ...input,
      assistantMessageId: input.assistantMessageId,
    });

  if (!latestUserMessage || !latestAssistantMessage) {
    throw new ContentError(
      400,
      "THREAD_RESUME_NOT_AVAILABLE",
      "No interrupted assistant response available to resume",
    );
  }

  const checkpoint = resolveAgentCheckpointMetadata(latestAssistantMessage);
  const resumeCheckpoint = resolveToolConfirmationResumeCheckpoint(checkpoint);

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
  const generatePptxTool =
    input.tools !== undefined
      ? resolveGeneratePptxToolSelection(input.tools)
      : resolveGeneratePptxToolFromMessage(latestUserMessage);
  const generateVideoPresentationTool =
    input.tools !== undefined
      ? resolveGenerateVideoPresentationToolSelection(input.tools)
      : resolveGenerateVideoPresentationToolFromMessage(latestUserMessage);
  const notionTools =
    input.tools !== undefined
      ? resolveNotionToolSelections(input.tools)
      : resolveNotionToolSelectionsFromMessage(latestUserMessage);
  const mcpTools =
    input.tools !== undefined
      ? resolveMcpToolSelection(input.tools)
      : resolveMcpToolSelectionFromMessage(latestUserMessage);
  const resumeRunThreadId = `thread:${input.threadId}:resume:${latestUserMessage.id}:${latestAssistantMessage.id}:${input.idempotencyKey ?? randomUUID()}`;
  const toolApprovalResume = mergeToolApprovalResumeConnectorActions({
    priorConnectorActions:
      extractApprovedConnectorActionsFromMessage(latestAssistantMessage),
    resume: input.toolApprovalResume,
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
      generatePptxTool,
      generateVideoPresentationTool,
      notionTools,
      mcpTools,
    }),
    command: input.command,
    invocation: input.invocation,
    timezone: input.timezone,
    idempotencyKey: input.idempotencyKey,
    llm: input.llm,
    image: input.image,
    vision: input.vision,
    visionProfileAlias: input.visionProfileAlias,
    existingUserMessage: latestUserMessage,
    assistantMessageParentId: latestAssistantMessage.parentMessageId,
    assistantMessageId: input.assistantMessageId,
    agentMode: "replay",
    agentBaseCheckpoint: resumeCheckpoint,
    agentRunThreadId: resumeRunThreadId,
    toolApprovalResume,
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
  const generatePptxTool =
    input.tools !== undefined
      ? resolveGeneratePptxToolSelection(input.tools)
      : resolveGeneratePptxToolFromMessage(latestUserMessage);
  const generateVideoPresentationTool =
    input.tools !== undefined
      ? resolveGenerateVideoPresentationToolSelection(input.tools)
      : resolveGenerateVideoPresentationToolFromMessage(latestUserMessage);
  const notionTools =
    input.tools !== undefined
      ? resolveNotionToolSelections(input.tools)
      : resolveNotionToolSelectionsFromMessage(latestUserMessage);
  const mcpTools =
    input.tools !== undefined
      ? resolveMcpToolSelection(input.tools)
      : resolveMcpToolSelectionFromMessage(latestUserMessage);
  const agentBaseCheckpoint =
    await resolveFallbackEditBaseCheckpoint({
      workspace,
      thread,
      latestUserMessageId: latestUserMessage.id,
    });

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
      generatePptxTool,
      generateVideoPresentationTool,
      notionTools,
      mcpTools,
    }),
    command: input.command,
    invocation: input.invocation,
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
    contextAnchorUserMessageId: latestUserMessage.id,
    failurePersistence: "persist-error-turn",
  };
}

export const testExports = {
  extractApprovedConnectorActionsFromMessage,
  getMessageMetadataRecord,
  mergeToolApprovalResumeConnectorActions,
  resolveEditBaseCheckpointFromMessages,
  resolveFallbackEditBaseCheckpoint,
  resolveResumeThreadStreamInput,
  resolveToolConfirmationResumeCheckpoint,
  shouldUseSubmittedEditImages,
};
