import { randomUUID } from "node:crypto";
import type { ToolApprovalResume } from "@sourceweft/contracts";
import { isAgentToolDomain } from "@sourceweft/agent-tool-registry";
import { stableJsonStringify } from "../../connectors/json-compare";
import { ContentError } from "../../content/errors";
import { dedupeSourceIds } from "../../sources/source-ids";
import {
  collapseSupersededMessages,
  filterMessagesBeforeEditAnchor,
  isContextExcludedMessage,
  resolveAgentCheckpointMetadata,
  resolveMentionedSourceIdsFromMessage,
  resolveSkillIdsFromMessage,
  resolveSourceIdsFromMessage,
  resolveTurnOptionsToolsFromMessage,
  resolveThreadTurnContext,
} from "../turn/context";
import { normalizeSkillIds } from "../../skills/selection";
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

function resolveRequestToolsWithSnapshot(input: {
  requestTools: StreamThreadEventInput["tools"];
  userMessage: Parameters<typeof resolveTurnOptionsToolsFromMessage>[0];
}) {
  return input.requestTools ?? resolveTurnOptionsToolsFromMessage(input.userMessage);
}

function resolveSnapshotTools(input: {
  userMessage: Parameters<typeof resolveTurnOptionsToolsFromMessage>[0];
}) {
  return resolveTurnOptionsToolsFromMessage(input.userMessage);
}

function resolveSkillIdsForTools(input: {
  tools: StreamThreadEventInput["tools"];
  userMessage: Parameters<typeof resolveSkillIdsFromMessage>[0];
}) {
  return input.tools
    ? normalizeSkillIds(input.tools.skillIds)
    : resolveSkillIdsFromMessage(input.userMessage);
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

type SandboxActionResumeRef = NonNullable<
  NonNullable<ToolApprovalResume["sourceweft"]>["sandboxActions"]
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

function extractApprovedSandboxActionsFromMessage(message: {
  id?: string;
  metadata?: unknown;
}): SandboxActionResumeRef[] {
  const metadata = getMessageMetadataRecord(message);
  const sourceUserMessageId =
    getStringField(metadata, "sourceUserMessageId") ??
    getStringField(metadata, "userMessageId");
  const toolCalls = Array.isArray(metadata.toolCalls)
    ? metadata.toolCalls
    : [];
  const actions: SandboxActionResumeRef[] = [];

  for (const toolCall of toolCalls) {
    const toolCallRecord = getObjectRecord(toolCall);
    const output = getObjectRecord(toolCallRecord?.output);
    const action = getObjectRecord(output?.action);
    const execution = getObjectRecord(output?.execution);
    const sourceweft = getObjectRecord(execution?.sourceweft);
    const toolName =
      getStringField(action, "toolName") ??
      getStringField(toolCallRecord, "tool");
    if (!toolName || !isAgentToolDomain(toolName, "sandbox")) {
      continue;
    }

    const outputApproved =
      output?.type === "tool_confirmation_request" &&
      output.status === "approved";
    const traceApproved = toolCallRecord?.approvalState === "approved";
    if (!outputApproved && !traceApproved) {
      continue;
    }

    const toolCallId =
      getStringField(sourceweft, "sandboxExecuteToolCallId") ??
      getStringField(sourceweft, "toolCallId") ??
      getStringField(toolCallRecord, "approvalConfirmationId") ??
      getStringField(toolCallRecord, "id");
    const preview = getObjectRecord(output?.preview);
    const requestJson =
      getObjectRecord(preview?.requestJson) ??
      getObjectRecord(toolCallRecord?.input);
    if (!toolCallId || !requestJson) {
      continue;
    }

    actions.push({
      toolCallId,
      toolName,
      requestJson,
      ...(getStringField(output, "id")
        ? { confirmationId: getStringField(output, "id")! }
        : {}),
      ...(getStringField(sourceweft, "hitlInterruptId")
        ? { hitlInterruptId: getStringField(sourceweft, "hitlInterruptId")! }
        : {}),
      ...(sourceUserMessageId ? { sourceUserMessageId } : {}),
      ...(message.id ? { sourceAssistantMessageId: message.id } : {}),
    });
  }

  return actions;
}

function resumeIdentityFromSandboxAction(action: SandboxActionResumeRef) {
  return {
    confirmationId: action.confirmationId,
    hitlInterruptId: action.hitlInterruptId,
    sourceUserMessageId: action.sourceUserMessageId,
    sourceAssistantMessageId: action.sourceAssistantMessageId,
    sandboxExecuteToolCallId: action.toolCallId,
  };
}

function sandboxActionMatchesResumeIdentity(input: {
  action: SandboxActionResumeRef;
  resume: ToolApprovalResume;
}) {
  const sourceweft = input.resume.sourceweft;
  if (!sourceweft) {
    return false;
  }
  const identity = resumeIdentityFromSandboxAction(input.action);
  if (
    sourceweft.sourceAssistantMessageId &&
    identity.sourceAssistantMessageId &&
    sourceweft.sourceAssistantMessageId !== identity.sourceAssistantMessageId
  ) {
    return false;
  }
  if (
    sourceweft.sourceUserMessageId &&
    identity.sourceUserMessageId &&
    sourceweft.sourceUserMessageId !== identity.sourceUserMessageId
  ) {
    return false;
  }
  if (
    sourceweft.confirmationId &&
    identity.confirmationId &&
    sourceweft.confirmationId !== identity.confirmationId
  ) {
    return false;
  }
  if (
    sourceweft.hitlInterruptId &&
    identity.hitlInterruptId &&
    sourceweft.hitlInterruptId !== identity.hitlInterruptId
  ) {
    return false;
  }
  return Boolean(
    (sourceweft.confirmationId &&
      identity.confirmationId === sourceweft.confirmationId) ||
      (sourceweft.hitlInterruptId &&
        identity.hitlInterruptId === sourceweft.hitlInterruptId) ||
      (sourceweft.sandboxExecuteToolCallId &&
        identity.sandboxExecuteToolCallId === sourceweft.sandboxExecuteToolCallId),
  );
}

function resumeHasSandboxIdentity(resume: ToolApprovalResume) {
  const sourceweft = resume.sourceweft;
  return Boolean(
    sourceweft?.confirmationId ||
      sourceweft?.hitlInterruptId ||
      sourceweft?.sandboxExecuteToolCallId ||
      sourceweft?.sourceUserMessageId ||
      sourceweft?.sourceAssistantMessageId,
  );
}

function selectLegacySandboxActionsForResume(input: {
  priorSandboxActions: SandboxActionResumeRef[];
  resume: ToolApprovalResume;
}) {
  const existingSandboxActions = input.resume.sourceweft?.sandboxActions ?? [];
  if (existingSandboxActions.length > 0) {
    if (!resumeHasSandboxIdentity(input.resume)) {
      return existingSandboxActions;
    }
    return existingSandboxActions.filter((action) =>
      sandboxActionMatchesResumeIdentity({
        action,
        resume: input.resume,
      }),
    );
  }
  return input.priorSandboxActions.filter((action) =>
    sandboxActionMatchesResumeIdentity({
      action,
      resume: input.resume,
    }),
  );
}

function mergeToolApprovalResumeActions(input: {
  priorConnectorActions: ConnectorActionResumeRef[];
  priorSandboxActions: SandboxActionResumeRef[];
  resume: ToolApprovalResume;
}): ToolApprovalResume {
  const existingActions = input.resume.sourceweft?.connectorActions ?? [];
  const selectedSandboxActions = selectLegacySandboxActionsForResume({
    priorSandboxActions: input.priorSandboxActions,
    resume: input.resume,
  });
  const mergedActions: ConnectorActionResumeRef[] = [];
  const mergedSandboxActions: SandboxActionResumeRef[] = [];
  const seen = new Set<string>();
  const seenSandbox = new Set<string>();

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

  for (const action of selectedSandboxActions) {
    const key = `${action.toolName}:${action.toolCallId}:${stableJsonStringify(
      action.requestJson,
    )}`;
    if (seenSandbox.has(key)) {
      continue;
    }
    seenSandbox.add(key);
    mergedSandboxActions.push(action);
  }

  if (
    mergedActions.length === 0 &&
    mergedSandboxActions.length === 0 &&
    !input.resume.sourceweft?.hitlInterruptId &&
    !input.resume.sourceweft?.sandboxExecuteToolCallId
  ) {
    return input.resume;
  }

  return {
    ...input.resume,
    sourceweft: {
      ...(input.resume.sourceweft ?? {}),
      ...(mergedActions.length > 0 ? { connectorActions: mergedActions } : {}),
      ...(mergedSandboxActions.length > 0
        ? { sandboxActions: mergedSandboxActions }
        : {}),
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
  const tools = resolveRequestToolsWithSnapshot({
    requestTools: input.tools,
    userMessage: latestUserMessage,
  });
  const skillIds = resolveSkillIdsForTools({
    tools,
    userMessage: latestUserMessage,
  });
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
    tools: tools ? { ...tools, skillIds } : { skillIds },
    command: input.command,
    invocation: input.invocation,
    timezone: input.timezone,
    idempotencyKey: input.idempotencyKey,
    llm: input.llm,
    image: input.image,
    vision: input.vision,
    imageProfileAlias: input.imageProfileAlias,
    visionProfileAlias: input.visionProfileAlias,
    existingUserMessage: latestUserMessage,
    assistantMessageParentId: latestAssistantMessage.id,
    assistantMessageId: null,
    agentMode: checkpoint?.beforeInput ? "fork" : "continue",
    agentBaseCheckpoint: checkpoint?.beforeInput ?? null,
    agentRunThreadId: refreshRunThreadId,
    toolApprovalResume: null,
    failurePersistence: "persist-error-turn",
    mcpInstallIds: input.mcpInstallIds,
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
  const tools = resolveSnapshotTools({
    userMessage: latestUserMessage,
  });
  const skillIds = resolveSkillIdsForTools({
    tools,
    userMessage: latestUserMessage,
  });
  const resumeRunThreadId = `thread:${input.threadId}:resume:${latestUserMessage.id}:${latestAssistantMessage.id}:${input.idempotencyKey ?? randomUUID()}`;
  const toolApprovalResume = mergeToolApprovalResumeActions({
    priorConnectorActions:
      extractApprovedConnectorActionsFromMessage(latestAssistantMessage),
    priorSandboxActions:
      extractApprovedSandboxActionsFromMessage(latestAssistantMessage),
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
    tools: tools ? { ...tools, skillIds } : { skillIds },
    command: input.command,
    invocation: input.invocation,
    timezone: input.timezone,
    idempotencyKey: input.idempotencyKey,
    llm: input.llm,
    image: input.image,
    vision: input.vision,
    imageProfileAlias: input.imageProfileAlias,
    visionProfileAlias: input.visionProfileAlias,
    existingUserMessage: latestUserMessage,
    assistantMessageParentId: latestAssistantMessage.parentMessageId,
    assistantMessageId: input.assistantMessageId,
    agentMode: "replay",
    agentBaseCheckpoint: resumeCheckpoint,
    agentRunThreadId: resumeRunThreadId,
    toolApprovalResume,
    failurePersistence: "persist-error-turn",
    mcpInstallIds: input.mcpInstallIds,
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
  const tools = resolveRequestToolsWithSnapshot({
    requestTools: input.tools,
    userMessage: latestUserMessage,
  });
  const skillIds = resolveSkillIdsForTools({
    tools,
    userMessage: latestUserMessage,
  });
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
    tools: tools ? { ...tools, skillIds } : { skillIds },
    command: input.command,
    invocation: input.invocation,
    timezone: input.timezone,
    idempotencyKey: input.idempotencyKey,
    llm: input.llm,
    image: input.image,
    vision: input.vision,
    imageProfileAlias: input.imageProfileAlias,
    visionProfileAlias: input.visionProfileAlias,
    userMessageParentId: latestUserMessage.id,
    assistantMessageParentId: latestAssistantMessage?.id ?? null,
    agentMode: "fork",
    agentBaseCheckpoint,
    agentRunThreadId: `thread:${input.threadId}:edit:${latestUserMessage.id}:${input.idempotencyKey ?? randomUUID()}`,
    contextAnchorUserMessageId: latestUserMessage.id,
    failurePersistence: "persist-error-turn",
    mcpInstallIds: input.mcpInstallIds,
  };
}

export const testExports = {
  extractApprovedConnectorActionsFromMessage,
  extractApprovedSandboxActionsFromMessage,
  getMessageMetadataRecord,
  mergeToolApprovalResumeActions,
  mergeToolApprovalResumeConnectorActions: mergeToolApprovalResumeActions,
  resolveEditBaseCheckpointFromMessages,
  resolveFallbackEditBaseCheckpoint,
  resolveResumeThreadStreamInput,
  resolveToolConfirmationResumeCheckpoint,
  shouldUseSubmittedEditImages,
};
