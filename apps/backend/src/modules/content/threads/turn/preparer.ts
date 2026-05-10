import { randomUUID } from "node:crypto";
import type { LlmExecutionConfig } from "../../model-gateway-audit";
import { ContentError } from "../../errors";
import { dedupeSourceIds } from "../../source-ids";
import { requireContentWorkspace } from "../../content-support";
import {
  normalizeSkillIds,
  resolveSelectedSkills,
} from "../../skills/selection";
import {
  findThreadRecord,
  updateThreadModelSettingsRecord,
} from "../thread/repository";
import {
  createMessageRecord,
  listMessageRecordsByThread,
  updateMessageMetadataRecord,
} from "../message-repository";
import {
  applyResolvedThreadModelSettings,
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
  resolveThreadChatProfile,
} from "./model-resolution";
import { assertSourcesExist } from "./source-validation";
import type { PreparedThreadTurn, StreamThreadEventInput } from "./types";
import { resolveSourceTreeScope } from "../../sources/service";
import { normalizeArtifactToolSelection } from "../../artifacts/types";
import { runArtifactIntentPipeline } from "../../artifacts/intent-pipeline";

function normalizeSupportedParameters(value: unknown) {
  if (!Array.isArray(value)) {
    return [] as string[];
  }

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
}

const REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
const DEFAULT_TIMEZONE = "UTC";

function normalizeSupportedEfforts(value: unknown) {
  if (!Array.isArray(value)) {
    return [] as Array<(typeof REASONING_EFFORTS)[number]>;
  }

  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().toLowerCase())
        .filter((item): item is (typeof REASONING_EFFORTS)[number] =>
          REASONING_EFFORTS.includes(
            item as (typeof REASONING_EFFORTS)[number],
          ),
        ),
    ),
  );
}

function isValidTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function normalizeTimezone(value: unknown) {
  if (typeof value !== "string") {
    return DEFAULT_TIMEZONE;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 100) {
    return DEFAULT_TIMEZONE;
  }

  return isValidTimeZone(trimmed) ? trimmed : DEFAULT_TIMEZONE;
}

function resolvePreparedLlmConfig(input: {
  chatProfile: Awaited<ReturnType<typeof resolveActiveChatProfileByAlias>>;
  llm?: LlmExecutionConfig;
}): LlmExecutionConfig | undefined {
  if (!input.llm?.thinking) {
    return input.llm;
  }

  const configJson =
    input.chatProfile.configJson &&
    typeof input.chatProfile.configJson === "object"
      ? (input.chatProfile.configJson as Record<string, unknown>)
      : {};
  const supportedParameters = normalizeSupportedParameters(
    configJson.supportedParameters,
  );
  const supportedEfforts = normalizeSupportedEfforts(
    configJson.supportedEfforts,
  );

  return {
    ...input.llm,
    thinking: {
      ...input.llm.thinking,
      supportedParameters,
      supportedEfforts,
    },
  };
}

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

  const requestedProfileAlias =
    typeof input.llm?.profileAlias === "string"
      ? input.llm.profileAlias.trim()
      : "";
  const requestedModelAlias =
    typeof input.llm?.modelAlias === "string"
      ? input.llm.modelAlias.trim()
      : "";

  const resolvedChatModel = await resolveThreadChatProfile({
    threadModelSettings: normalizeThreadModelSettings(thread.modelSettings),
    requestedProfileAlias: requestedProfileAlias || undefined,
    requestedModelAlias: requestedProfileAlias ? undefined : requestedModelAlias || undefined,
  });

  const mentionedSourceIds = dedupeSourceIds(input.mentionedSourceIds);
  const mentionedSourceScope = await resolveSourceTreeScope({
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
    selectedSourceIds: mentionedSourceIds,
  });
  const effectiveMentionedSourceIds = mentionedSourceScope.effectiveSourceIds;
  const requestedSourceIds = dedupeSourceIds(input.sourceIds);
  const existingUserMessage = input.existingUserMessage;
  const assistantMessageParentId = input.assistantMessageParentId ?? null;
  const messageRecords = await listMessageRecordsByThread({
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
    threadId: thread.id,
  });

  const fallbackSourceIds = resolveLatestSourceIds(messageRecords);
  const selectedSourceIds =
    requestedSourceIds.length > 0 ? requestedSourceIds : fallbackSourceIds;
  const sourceScope = await resolveSourceTreeScope({
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
    selectedSourceIds,
  });
  const sourceIds = sourceScope.effectiveSourceIds;
  const skillIds = normalizeSkillIds(input.tools?.skillIds);
  const requestedWebSearchEnabled = input.tools?.webSearchEnabled === true;
  const artifact = normalizeArtifactToolSelection(input.tools?.artifact);
  const timezone = normalizeTimezone(input.timezone);
  const enabledSkills = await resolveSelectedSkills({
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
    skillIds,
  });
  const webSearchEnabled =
    requestedWebSearchEnabled ||
    enabledSkills.some((skill) => skill.tools?.includes("web_search"));

  await assertSourcesExist({
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
    sourceIds: Array.from(
      new Set([...selectedSourceIds, ...mentionedSourceIds]),
    ),
  });

  const normalizedThreadSettings = normalizeThreadModelSettings(
    thread.modelSettings,
  );
  const artifactPipeline = await runArtifactIntentPipeline({
    content: messageContent,
    tools: artifact ? { artifact } : undefined,
    enabledSkills,
    threadModelSettings: normalizedThreadSettings,
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
        ...(mentionedSourceIds.length > 0
          ? {
              mentionedSourceIds,
              effectiveMentionedSourceIds,
            }
          : {}),
        sourceIds: selectedSourceIds,
        effectiveSourceIds: sourceIds,
        skillIds,
        tools: {
          skillIds,
          webSearchEnabled,
          ...(artifact ? { artifact } : {}),
        },
        artifactIntent: artifactPipeline.decision,
        versionOf: input.userMessageParentId ?? null,
      },
    }));
  const createdUserMessage = !existingUserMessage;

  const isFirstAssistantResponse = !messageRecords.some(
    (message) =>
      message.role === "assistant" && !isContextExcludedMessage(message),
  );
  const initialTitle = thread.title;

  const profileAlias = resolvedChatModel.profileAlias;
  const modelAlias = resolvedChatModel.modelAlias;
  const chatProfile = await resolveActiveChatProfileByAlias(profileAlias);
  const llm = resolvePreparedLlmConfig({ chatProfile, llm: input.llm });
  if (
    normalizedThreadSettings.llmProfileAlias !== profileAlias ||
    normalizedThreadSettings.llmModelAlias !== modelAlias
  ) {
    const updatedThread = await updateThreadModelSettingsRecord({
      threadId: thread.id,
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      modelSettings: applyResolvedThreadModelSettings(
        normalizedThreadSettings,
        {
          llm: { profileAlias, modelAlias },
        },
      ),
    });
    if (updatedThread) {
      thread = updatedThread;
    }
  }
  const agentMode = input.agentMode ?? "continue";
  const latestAssistantCheckpoint =
    agentMode === "continue"
      ? resolveLatestAssistantFinalCheckpoint(messageRecords)
      : null;
  const agentBaseCheckpoint =
    input.agentBaseCheckpoint !== undefined
      ? input.agentBaseCheckpoint
      : latestAssistantCheckpoint;

  const llmIdempotencyKey =
    input.idempotencyKey ||
    (assistantMessageParentId
      ? `thread-refresh:${userMessage.id}:${assistantMessageParentId}:${randomUUID()}`
      : `thread-stream:${userMessage.id}:assistant`);

  const agentRunThreadId = input.agentRunThreadId ?? thread.id;
  const runTraceId = existingUserMessage
    ? `thread-run:${randomUUID()}`
    : userMessage.id;
  const userMessageWithTraceId = existingUserMessage
    ? userMessage
    : ((await updateMessageMetadataRecord({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        threadId: thread.id,
        messageId: userMessage.id,
        metadata: {
          ...userMessage.metadata,
          traceId: runTraceId,
        },
      })) ?? {
        ...userMessage,
        metadata: { ...userMessage.metadata, traceId: runTraceId },
      });

  return {
    userId: input.userId,
    workspace,
    thread,
    messageContent,
    mentionedSourceIds,
    effectiveMentionedSourceIds,
    selectedSourceIds,
    sourceIds,
    sourceScope,
    skillIds,
    webSearchEnabled,
    artifact,
    artifactIntent: artifactPipeline.decision,
    imageProfile: artifactPipeline.imageProfile,
    timezone,
    enabledSkills,
    userMessage: userMessageWithTraceId,
    runTraceId,
    createdUserMessage,
    assistantMessageParentId,
    profileAlias,
    modelAlias,
    chatProfile,
    llm,
    llmIdempotencyKey,
    agentMode,
    agentBaseCheckpoint,
    agentRunThreadId,
    isFirstAssistantResponse,
    initialTitle,
    failurePersistence: input.failurePersistence ?? "persist-error-turn",
  };
}

function resolveLatestSourceIds(
  messageRecords: Awaited<ReturnType<typeof listMessageRecordsByThread>>,
) {
  const messages = collapseSupersededMessages(messageRecords).filter(
    (message) => !isContextExcludedMessage(message),
  );

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

function resolveLatestAssistantFinalCheckpoint(
  messageRecords: Awaited<ReturnType<typeof listMessageRecordsByThread>>,
) {
  const messages = collapseSupersededMessages(messageRecords).filter(
    (message) => !isContextExcludedMessage(message),
  );

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
