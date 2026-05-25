import { buildAgentConfig, createThreadAgent } from "..";
import type {
  ToolApprovalResume,
  ToolApprovalResumeDecision,
  ToolConfirmationRequest,
} from "@sourceweft/contracts";
import { Command } from "@langchain/langgraph";
import { AgentCitationRegistry } from "../citation-registry";
import { DatabaseKnowledgeBackend } from "../database-fs-backend";
import { createDefaultFilesystemMounts } from "../filesystem-capabilities";
import { MountedAgentFilesystemBackend } from "../mounted-fs-backend";
import { createRetrievalTool } from "../tools/retrieval-tool";
import {
  createGenerateImageTool,
  GENERATED_IMAGE_PROGRESS_EVENT_TYPE,
} from "../tools/generate-image-tool";
import { WorkingFilesBackend } from "../working-files-backend";
import type {
  ConnectorActionApprovalCursor,
  ConnectorActionExecutionCursor,
} from "../../../connectors/agent-tool-idempotency";
import {
  buildConnectorActionApprovalScope,
  peekConnectorActionExecutionRef,
} from "../../../connectors/agent-tool-idempotency";
import {
  createConnectorActionApprovalRequest,
  createConnectorActionInterruptConfigs,
  createConnectorActionTools,
} from "../../../connectors/agent-tools";
import { mcpService } from "../../../mcp";
import { createWebTools } from "../tools/web-tools";
import {
  AGENT_TOOL_NAMES,
  isGeneratedImageArtifactToolName,
  isPatternScopeToolName,
  isReadToolOutputToolName,
  isRetrievalToolName,
  isWebFetchToolName,
  isWebSearchToolName,
  isWebToolName,
  isAgentToolDomain,
} from "../tool-registry";
import { ContentError } from "../../errors";
import { sanitizeNonCitableCitationMarkers } from "../fs-utils";
import { SelectedSkillsBackend } from "../../skills/backend";
import { createDefaultWebProvider } from "../../web";
import { listVirtualFsSources } from "../../virtual-fs/store";
import type { VirtualFsSource } from "../../virtual-fs/types";
import type { LlmExecutionConfig } from "../../model-gateway-audit";
import type { ContentBillingPort } from "../../billing-port";
import type { TraceContext } from "../../../../shared/llm-observability";
import { endSpan, startSpan } from "../../../../shared/llm-observability";
import { contentRetrievalService } from "../../retrieval/service";
import type {
  AgentCheckpointRef,
  CommandSuccessCriteria,
  MessageRenderBlock,
  PreparedThreadTurn,
  RetrievalCallTrace,
  ThinkingStepTrace,
  ToolCallTrace,
} from "../../threads";
import {
  createMessageRenderBlockBuilder,
  finalizeMessageRenderBlocks,
} from "../../threads/turn/render-blocks";
import {
  extractTextDeltasFromMessageChunk,
  extractFinishReasonFromMessageChunk,
  extractProviderFieldsFromMessageChunk,
  extractReasoningFromMessageChunk,
  extractUsageFromMessageChunk,
  resolveAssistantContentFromUpdatesChunk,
  sanitizeSseValue,
  toObjectRecord,
} from "./content";
import { normalizeAssistantCitations } from "./citations";
import type { DeepAgentTurnEvent } from "./events";
import type { DeepAgentTurnOutcome } from "./events";
export type { DeepAgentTurnEvent, DeepAgentTurnOutcome } from "./events";
import { listThinkingSteps, upsertThinkingStep } from "./thinking";
import {
  normalizeErrorText,
  normalizeToolInput,
  resolveToolCallId,
  type ToolCallStatus,
} from "./tool-utils";
import { logger } from "../../../../shared/logger";

function checkpointRefToConfig(checkpoint: AgentCheckpointRef) {
  return {
    configurable: {
      thread_id: checkpoint.threadId,
      checkpoint_id: checkpoint.checkpointId,
      checkpoint_ns: checkpoint.checkpointNs ?? "",
    },
  };
}

function checkpointRefToResumeConfig(checkpoint: AgentCheckpointRef) {
  return buildAgentConfig(
    checkpoint.threadId,
    {
      checkpoint_map: {
        [checkpoint.checkpointNs ?? ""]: checkpoint.checkpointId,
      },
      checkpoint_ns: checkpoint.checkpointNs ?? "",
    },
  );
}

function resolveAgentBaseConfig(input: {
  agentBaseCheckpoint: AgentCheckpointRef | null;
  agentMode: PreparedThreadTurn["agentMode"];
  agentRunThreadId: string;
}) {
  if (input.agentMode === "replay") {
    if (!input.agentBaseCheckpoint) {
      throw new ContentError(
        400,
        "AGENT_HITL_CHECKPOINT_REQUIRED",
        "DeepAgents HITL replay requires a checkpoint from the interrupted thread.",
      );
    }
    return checkpointRefToResumeConfig(input.agentBaseCheckpoint);
  }

  return input.agentBaseCheckpoint
    ? checkpointRefToConfig(input.agentBaseCheckpoint)
    : buildAgentConfig(input.agentRunThreadId);
}

function checkpointRefFromConfig(value: unknown): AgentCheckpointRef | null {
  const config = toObjectRecord(value);
  const configurable = toObjectRecord(config?.configurable);
  if (!configurable) {
    return null;
  }

  const threadId =
    typeof configurable.thread_id === "string" ? configurable.thread_id : null;
  const checkpointId =
    typeof configurable.checkpoint_id === "string"
      ? configurable.checkpoint_id
      : null;
  if (!threadId || !checkpointId) {
    return null;
  }

  const checkpointNs =
    typeof configurable.checkpoint_ns === "string"
      ? configurable.checkpoint_ns
      : undefined;

  return checkpointNs === undefined
    ? { threadId, checkpointId }
    : { threadId, checkpointId, checkpointNs };
}

function checkpointHasPendingTasks(value: unknown) {
  const record = toObjectRecord(value);
  return Array.isArray(record?.next) && record.next.length > 0;
}

async function resolvePendingInterruptCheckpoint(input: {
  agent: Awaited<ReturnType<typeof createThreadAgent>>;
  config: AgentRunnableConfig;
}) {
  const state = await getAgentStateOrNull(input.agent, input.config);
  const checkpoint = checkpointRefFromConfig(
    (state as { config?: unknown } | null)?.config,
  );
  return {
    checkpoint,
    pending: checkpointHasPendingTasks(state),
  };
}

function resolveHitlInterruptCheckpoint(input: {
  pendingCheckpoint: {
    checkpoint: AgentCheckpointRef | null;
    pending: boolean;
  };
  observedCheckpoint: AgentCheckpointRef | null;
}) {
  if (input.pendingCheckpoint.pending && input.pendingCheckpoint.checkpoint) {
    return input.pendingCheckpoint.checkpoint;
  }

  return input.observedCheckpoint;
}

type AgentRunnableConfig =
  Awaited<ReturnType<typeof createThreadAgent>> extends {
    stream: (input: unknown, config?: infer Config) => unknown;
  }
    ? NonNullable<Config>
    : Record<string, unknown>;

async function getAgentStateOrNull(
  agent: Awaited<ReturnType<typeof createThreadAgent>>,
  config: AgentRunnableConfig,
) {
  try {
    return await agent.getState(config);
  } catch {
    return null;
  }
}

function addUsage(
  current: DeepAgentTurnOutcome["usage"],
  next: DeepAgentTurnOutcome["usage"],
): DeepAgentTurnOutcome["usage"] {
  if (!next) {
    return current;
  }

  const sum = (left?: number, right?: number) =>
    left === undefined && right === undefined
      ? undefined
      : (left ?? 0) + (right ?? 0);
  const costDetails = {
    ...(current?.costDetails ?? {}),
    ...(next.costDetails ?? {}),
  };

  return {
    inputTokens: sum(current?.inputTokens, next.inputTokens),
    outputTokens: sum(current?.outputTokens, next.outputTokens),
    totalTokens: sum(current?.totalTokens, next.totalTokens),
    cacheReadTokens: sum(current?.cacheReadTokens, next.cacheReadTokens),
    cacheWriteTokens: sum(current?.cacheWriteTokens, next.cacheWriteTokens),
    reasoningTokens: sum(current?.reasoningTokens, next.reasoningTokens),
    inputImageTokens: sum(current?.inputImageTokens, next.inputImageTokens),
    outputImageTokens: sum(current?.outputImageTokens, next.outputImageTokens),
    inputImageCount: sum(current?.inputImageCount, next.inputImageCount),
    outputImageCount: sum(current?.outputImageCount, next.outputImageCount),
    inputAudioTokens: sum(current?.inputAudioTokens, next.inputAudioTokens),
    outputAudioTokens: sum(current?.outputAudioTokens, next.outputAudioTokens),
    providerCostUsd: sum(current?.providerCostUsd, next.providerCostUsd),
    providerCostSource: next.providerCostSource ?? current?.providerCostSource,
    costDetails: Object.keys(costDetails).length > 0 ? costDetails : undefined,
  };
}

function appendReasoningChunk(current: string | undefined, next: string) {
  if (!current) {
    return next;
  }
  if (next === current) {
    return current;
  }
  if (next.startsWith(current)) {
    return next;
  }
  return `${current}${next}`;
}

function createModelReasoningSegmentId(input: {
  runTraceId: string;
  index: number;
}) {
  return `model-reasoning:${input.runTraceId}:${input.index}`;
}

function resolveToolCommand(input: PreparedThreadTurn) {
  if (
    input.command?.kind === "tool" &&
    input.command.toolName === AGENT_TOOL_NAMES.generateImage &&
    input.command.workflow?.execution === "direct" &&
    input.generateImageTool?.mode === "generate" &&
    input.artifactIntent.shouldInjectTool &&
    input.imageProfile
  ) {
    return {
      name: AGENT_TOOL_NAMES.generateImage,
      prompt: input.command.arguments?.trim() || input.messageContent.trim(),
    };
  }

  return null;
}

function isCommandSuccessSatisfied(input: {
  criteria: CommandSuccessCriteria;
  toolCalls: ToolCallTrace[];
}) {
  const { criteria } = input;
  switch (criteria.kind) {
    case "none":
      return true;
    case "artifact":
      return input.toolCalls.some((call) => {
        if (
          call.tool !== criteria.toolName ||
          call.status !== "completed" ||
          call.error
        ) {
          return false;
        }
        if (criteria.artifactType !== "image") {
          return true;
        }
        return Boolean(extractToolOutputField(call.output, "artifact_url"));
      });
    case "tool_call":
      return input.toolCalls.some(
        (call) =>
          call.tool === criteria.toolName &&
          call.status === "completed" &&
          !call.error,
      );
  }
}

function commandSuccessFailureText(
  criteria: CommandSuccessCriteria,
  toolCalls: ToolCallTrace[] = [],
) {
  switch (criteria.kind) {
    case "none":
      return "Command failed because its success criteria were not satisfied.";
    case "artifact":
      if (toolCalls.some((call) => call.tool === criteria.toolName)) {
        return `Command failed because ${criteria.toolName} did not create a ${criteria.artifactType} artifact.`;
      }
      return `Command failed because ${criteria.toolName} did not create a ${criteria.artifactType} artifact.`;
    case "tool_call":
      if (toolCalls.some((call) => call.tool === criteria.toolName)) {
        return `Command failed because ${criteria.toolName} did not complete successfully.`;
      }
      return `Command failed because ${criteria.toolName} was not called.`;
  }
}

function buildCommandSuccessInstruction(criteria: CommandSuccessCriteria) {
  switch (criteria.kind) {
    case "none":
      return "";
    case "artifact":
      return `Command success requires creating a ${criteria.artifactType} artifact by completing ${criteria.toolName}. Do not finish this turn as successful until that happens.`;
    case "tool_call":
      return `Command success requires calling ${criteria.toolName}. You may use supporting tools first if needed, but do not finish this turn as successful until ${criteria.toolName} has been called or you have a concrete tool/runtime error.`;
  }
}

function buildCommandRetryInstruction(criteria: CommandSuccessCriteria) {
  const completion = buildCommandSuccessInstruction(criteria);
  if (!completion) {
    return "";
  }
  return [
    "The previous attempt did not satisfy the slash command success criteria.",
    completion,
    "Retry now. Do not provide a normal final answer until the command succeeds or the required tool/runtime error is explicit.",
  ].join("\n");
}

function getToolPermission(
  prepared: PreparedThreadTurn,
  toolName: string,
): "allow" | "ask" | "deny" {
  return prepared.toolPermissions[toolName] ?? "allow";
}

function isToolDenied(prepared: PreparedThreadTurn, toolName: string) {
  return getToolPermission(prepared, toolName) === "deny";
}

function filterAllowedTools<T extends { name: string }>(
  prepared: PreparedThreadTurn,
  tools: T[],
) {
  return tools.filter((tool) => !isToolDenied(prepared, tool.name));
}

async function runToolRetrieval(input: {
  prepared: PreparedThreadTurn;
  query: string;
  llm?: LlmExecutionConfig;
  traceContext?: TraceContext;
}) {
  return contentRetrievalService.runRetrieval({
    workspaceId: input.prepared.workspace.id,
    teamId: input.prepared.workspace.organizationId,
    threadId: input.prepared.thread.id,
    userId: input.prepared.userId,
    userMessageId: input.prepared.userMessage.id,
    queryText: input.query,
    anchorSourceIds: input.prepared.effectiveMentionedSourceIds,
    sourceIds: input.prepared.sourceIds,
    idempotencyKey: input.prepared.llmIdempotencyKey,
    llm: input.llm,
    traceContext: input.traceContext,
  });
}

function compactTraceText(value: string, maxLength = 96) {
  const compacted = value.replace(/\s+/g, " ").trim();
  if (compacted.length <= maxLength) {
    return compacted;
  }
  return `${compacted.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

const TOOL_INPUT_PREVIEW_FIELDS = [
  "query",
  "prompt",
  "url",
  "path",
  "pattern",
  "glob",
] as const;

const GENERATED_IMAGE_ALT = "Generated image";

function formatToolInputItems(input: Record<string, unknown>) {
  const entries = TOOL_INPUT_PREVIEW_FIELDS.map((key) => {
    const value = input[key];
    return typeof value === "string" && value.trim().length > 0
      ? `${key}: ${compactTraceText(value)}`
      : null;
  }).filter((item): item is string => item !== null);

  const items = input.items;
  if (Array.isArray(items)) {
    for (const item of items) {
      const record = toObjectRecord(item);
      const url = typeof record?.url === "string" ? record.url.trim() : "";
      if (url) {
        entries.push(`url: ${compactTraceText(url)}`);
      }
    }
  }

  return entries.slice(0, 3);
}

function extractWebFetchUrls(input: Record<string, unknown>) {
  const items = input.items;
  if (!Array.isArray(items)) {
    return [] as string[];
  }

  return items
    .map((item) => {
      const record = toObjectRecord(item);
      return typeof record?.url === "string" ? record.url.trim() : "";
    })
    .filter((url) => url.length > 0)
    .slice(0, 5);
}

function resolveFilesystemPath(input: Record<string, unknown>) {
  for (const key of ["path", "file_path", "filePath"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "";
}

function resolveFilesystemPattern(input: Record<string, unknown>) {
  const value = input.pattern;
  return typeof value === "string" ? value.trim() : "";
}

function scopeFromPath(path: string) {
  if (path.startsWith("/skills")) {
    return "skills";
  }
  if (path.startsWith("/work")) {
    return "work";
  }
  return null;
}

function filesystemScope(input: Record<string, unknown>, toolName?: string) {
  const pathScope = scopeFromPath(resolveFilesystemPath(input));
  if (pathScope) {
    return pathScope;
  }
  if (toolName && isPatternScopeToolName(toolName)) {
    const patternScope = scopeFromPath(resolveFilesystemPattern(input));
    if (patternScope) {
      return patternScope;
    }
  }
  return "sources";
}

const FILESYSTEM_TOOL_PRESENTERS = {
  [AGENT_TOOL_NAMES.ls]: {
    start: {
      work: "Listing Workfiles",
      skills: "Listing selected skills",
      sources: "Listing selected sources",
    },
    end: {
      work: "Listed Workfiles",
      skills: "Listed selected skills",
      sources: "Listed selected sources",
    },
    describe: (input: { metadata: Record<string, unknown> }) =>
      typeof input.metadata.resultCount === "number"
        ? `Listed ${input.metadata.resultCount} entries.`
        : undefined,
  },
  [AGENT_TOOL_NAMES.glob]: {
    start: {
      work: "Finding matching Workfiles",
      skills: "Finding matching skill files",
      sources: "Finding matching sources",
    },
    end: {
      work: "Found matching Workfiles",
      skills: "Found matching skill files",
      sources: "Found matching sources",
    },
    describe: (input: { metadata: Record<string, unknown> }) =>
      typeof input.metadata.resultCount === "number"
        ? `Found ${input.metadata.resultCount} matching paths.`
        : undefined,
  },
  [AGENT_TOOL_NAMES.grep]: {
    start: {
      work: "Searching Workfiles",
      skills: "Searching skill instructions",
      sources: "Searching exact terms",
    },
    end: {
      work: "Searched Workfiles",
      skills: "Searched skill instructions",
      sources: "Searched exact terms",
    },
    describe: (input: { metadata: Record<string, unknown> }) =>
      typeof input.metadata.matchCount === "number"
        ? `Found ${input.metadata.matchCount} text matches.`
        : undefined,
  },
  [AGENT_TOOL_NAMES.readFile]: {
    start: {
      work: "Reading Workfile",
      skills: "Reading skill instructions",
      sources: "Reading source content",
    },
    end: {
      work: "Read Workfile",
      skills: "Read skill instructions",
      sources: "Read source content",
    },
    describe: (input: {
      metadata: Record<string, unknown>;
      scope: ReturnType<typeof filesystemScope>;
      input?: Record<string, unknown>;
    }) => {
      const inputLimit = toObjectRecord(input.input)?.limit;
      if (input.scope === "sources") {
        const lineLimit =
          typeof inputLimit === "number" && Number.isFinite(inputLimit)
            ? Math.max(1, Math.floor(inputLimit))
            : undefined;
        return lineLimit
          ? `Read up to ${lineLimit} source lines.`
          : "Read source content.";
      }
      if (typeof input.metadata.chunkCount === "number") {
        const noun = input.scope === "skills" ? "skill" : "Workfile";
        return `Read ${input.metadata.chunkCount} ${noun} ${
          input.metadata.chunkCount === 1 ? "chunk" : "chunks"
        }.`;
      }
      return undefined;
    },
  },
} as const;

function getFilesystemToolPresenter(toolName: string) {
  return FILESYSTEM_TOOL_PRESENTERS[
    toolName as keyof typeof FILESYSTEM_TOOL_PRESENTERS
  ];
}

function getFilesystemToolStartTitle(
  toolName: string,
  input: Record<string, unknown>,
) {
  if (isGeneratedImageArtifactToolName(toolName)) {
    return "Generating image";
  }
  const scope = filesystemScope(input, toolName);
  return getFilesystemToolPresenter(toolName)?.start[scope] ?? null;
}

function getFilesystemToolEndTitle(
  toolName: string,
  input: Record<string, unknown>,
) {
  if (isGeneratedImageArtifactToolName(toolName)) {
    return "Generated image";
  }
  const scope = filesystemScope(input, toolName);
  return getFilesystemToolPresenter(toolName)?.end[scope] ?? null;
}

function extractToolOutputText(output: unknown) {
  if (typeof output === "string") {
    return output;
  }

  const record = toObjectRecord(output);
  if (!record) {
    return null;
  }

  if (typeof record.content === "string") {
    return record.content;
  }

  const kwargs =
    toObjectRecord(record.kwargs) ?? toObjectRecord(record.lc_kwargs);
  const content = kwargs?.content;
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        const itemRecord = toObjectRecord(item);
        return typeof itemRecord?.text === "string" ? itemRecord.text : null;
      })
      .filter((item): item is string => item !== null)
      .join("\n");
  }

  return null;
}

export function normalizeToolOutputForObservability(
  toolName: string,
  output: unknown,
) {
  if (isWebToolName(toolName)) {
    return normalizeWebToolOutput(toolName, output);
  }

  if (isAgentToolDomain(toolName, "connector")) {
    return normalizeConnectorToolOutput(toolName, output);
  }

  if (!isReadToolOutputToolName(toolName)) {
    return output;
  }

  const outputText = extractToolOutputText(output);
  if (outputText) {
    return { content: outputText };
  }

  const record = toObjectRecord(output);
  if (typeof record?.error === "string") {
    return { error: record.error };
  }

  return output;
}

function getPublicStringField(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function normalizeConnectorToolOutput(toolName: string, output: unknown) {
  const record = toObjectRecord(output);
  const outputText = extractToolOutputText(output);
  const parsedTextRecord = outputText ? parseJsonObject(outputText) : null;
  const publicRecord = parsedTextRecord ?? record;
  if (publicRecord?.type === "connector_tool_error") {
    return publicRecord;
  }
  if (publicRecord?.type === "tool_confirmation_request") {
    return sanitizeToolConfirmationForObservability(publicRecord);
  }

  const actionType = getPublicStringField(publicRecord, "actionType");
  const outputToolName = getPublicStringField(publicRecord, "toolName") ?? toolName;
  const title = getPublicStringField(publicRecord, "title");
  const url = getPublicStringField(publicRecord, "url");
  const pageId = getPublicStringField(publicRecord, "pageId");
  const query = getPublicStringField(publicRecord, "query");
  const resultCount =
    typeof publicRecord?.resultCount === "number" &&
    Number.isFinite(publicRecord.resultCount)
      ? publicRecord.resultCount
      : null;
  const pages = normalizeConnectorPageSummaries(publicRecord?.pages);
  return {
    type: "connector_tool_result",
    connector: "notion",
    toolName: outputToolName,
    ...(actionType ? { actionType } : {}),
    ...(title ? { title } : {}),
    ...(url ? { url } : {}),
    ...(pageId ? { pageId } : {}),
    ...(query ? { query } : {}),
    ...(resultCount !== null ? { resultCount } : {}),
    ...(pages.length > 0 ? { pages } : {}),
  };
}

function normalizeConnectorPageSummaries(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      const record = toObjectRecord(item);
      if (!record) {
        return null;
      }
      const pageId =
        typeof record.pageId === "string" && record.pageId.trim().length > 0
          ? record.pageId.trim()
          : null;
      const title =
        typeof record.title === "string" && record.title.trim().length > 0
          ? record.title.trim()
          : null;
      const url =
        typeof record.url === "string" && record.url.trim().length > 0
          ? record.url.trim()
          : null;
      const lastEditedTime =
        typeof record.lastEditedTime === "string" &&
        record.lastEditedTime.trim().length > 0
          ? record.lastEditedTime.trim()
          : null;
      if (!pageId && !title && !url) {
        return null;
      }
      return {
        ...(pageId ? { pageId } : {}),
        ...(title ? { title } : {}),
        ...(url ? { url } : {}),
        ...(lastEditedTime ? { lastEditedTime } : {}),
      };
    })
    .filter((item): item is Record<string, string> => item !== null);
}

function parseJsonObject(value: string) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }

  try {
    return toObjectRecord(JSON.parse(trimmed) as unknown);
  } catch {
    return null;
  }
}

function sanitizeToolConfirmationForObservability(
  confirmation: Record<string, unknown>,
) {
  const preview = toObjectRecord(confirmation.preview);
  const sanitized = {
    ...confirmation,
    preview: preview
      ? Object.fromEntries(
          Object.entries(preview).filter(([key]) => key !== "requestJson"),
        )
      : confirmation.preview,
  } as Record<string, unknown>;
  delete sanitized.editableArgs;
  return sanitized;
}

function extractToolPayloadInput(toolPayload: Record<string, unknown>) {
  for (const candidate of [toolPayload.input, toolPayload.args]) {
    const normalized = normalizeToolInput(candidate);
    if (Object.keys(normalized).length > 0) {
      return normalized;
    }
  }

  const data = toObjectRecord(toolPayload.data);
  if (!data) {
    return {};
  }

  for (const candidate of [data.input, data.args]) {
    const normalized = normalizeToolInput(candidate);
    if (Object.keys(normalized).length > 0) {
      return normalized;
    }
  }

  return {};
}

function getFilesystemToolMetadata(toolName: string, output: unknown) {
  const record = toObjectRecord(output);
  const metadata: Record<string, unknown> = {};

  if (isGeneratedImageArtifactToolName(toolName)) {
    const outputText = extractToolOutputText(output) ?? "";
    const artifactId = outputText.match(/artifact_id:\s*(\S+)/)?.[1];
    const artifactUrl = outputText.match(/artifact_url:\s*(\S+)/)?.[1];
    if (artifactId) {
      metadata.artifactId = artifactId;
    }
    if (artifactUrl) {
      metadata.artifactUrl = artifactUrl;
    }
    return metadata;
  }

  if (record && Array.isArray(record.files)) {
    metadata.resultCount = record.files.length;
  }
  if (record && Array.isArray(record.matches)) {
    metadata.matchCount = record.matches.length;
  }
  const outputText = extractToolOutputText(output);
  if (outputText) {
    const chunkMatches = outputText.match(/--- chunk |^Chunk:/gm);
    if (chunkMatches && chunkMatches.length > 0) {
      metadata.chunkCount = chunkMatches.length;
    }
    metadata.truncated = outputText.includes("Output truncated.");
  }

  if (isReadToolOutputToolName(toolName) && metadata.chunkCount === undefined) {
    metadata.chunkCount = 1;
  }

  return metadata;
}

function getFilesystemToolDescription(
  toolName: string,
  metadata: Record<string, unknown>,
  input?: Record<string, unknown>,
) {
  const scope = input ? filesystemScope(input, toolName) : "sources";
  if (isGeneratedImageArtifactToolName(toolName)) {
    return "Created an image artifact.";
  }
  return getFilesystemToolPresenter(toolName)?.describe({
    metadata,
    scope,
    input,
  });
}

type GeneratedImageArtifactReference = {
  artifactId: string | null;
  title: string;
  artifactUrl: string;
  toolCallId?: string;
};

type ObservedAgentToolCall = {
  args: Record<string, unknown>;
  id: string;
  index?: number;
  name: string;
};

type HitlActionRequest = {
  args: Record<string, unknown>;
  description?: string;
  name: string;
};

type HitlReviewConfig = {
  actionName: string;
  allowedDecisions: Array<"approve" | "edit" | "reject">;
  argsSchema?: Record<string, unknown>;
};

type HitlInterruptRequest = {
  id?: string;
  actionRequests: HitlActionRequest[];
  reviewConfigs: HitlReviewConfig[];
};

function extractToolOutputField(output: unknown, key: string) {
  const outputText = extractToolOutputText(output);
  if (!outputText) {
    return null;
  }

  const match = outputText.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim() ?? null;
}

function extractGeneratedImageArtifacts(
  toolCalls: ToolCallTrace[],
): GeneratedImageArtifactReference[] {
  const seen = new Set<string>();
  return toolCalls
    .filter(
      (call) =>
        isGeneratedImageArtifactToolName(call.tool) &&
        call.status === "completed" &&
        !call.error,
    )
    .map((call): GeneratedImageArtifactReference | null => {
      const artifactId =
        extractToolOutputField(call.output, "artifact_id") ?? "";
      const artifactUrl = extractToolOutputField(call.output, "artifact_url");
      const title =
        extractToolOutputField(call.output, "title") || GENERATED_IMAGE_ALT;

      return artifactUrl
        ? {
            artifactId: artifactId || null,
            artifactUrl,
            title,
            toolCallId: call.id,
          }
        : null;
    })
    .filter((artifact): artifact is GeneratedImageArtifactReference =>
      Boolean(artifact),
    )
    .filter((artifact) => {
      const key = artifact.artifactId ?? artifact.artifactUrl;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    return `{${entries
      .map(
        ([key, item]) => `${JSON.stringify(key)}:${stableJsonStringify(item)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameToolArgs(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
) {
  return stableJsonStringify(left) === stableJsonStringify(right);
}

function parseToolArgs(value: unknown): Record<string, unknown> {
  if (typeof value === "string" && value.trim().length > 0) {
    try {
      return parseToolArgs(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return toObjectRecord(value) ?? {};
}

function extractToolCallsFromRawProvider(value: unknown) {
  if (!Array.isArray(value)) {
    return [] as ObservedAgentToolCall[];
  }
  return value
    .map((candidate, index): ObservedAgentToolCall | null => {
      const record = toObjectRecord(candidate);
      if (!record) {
        return null;
      }
      const functionRecord = toObjectRecord(record.function);
      const name =
        typeof record.name === "string"
          ? record.name
          : typeof functionRecord?.name === "string"
            ? functionRecord.name
            : null;
      const id = typeof record.id === "string" ? record.id : null;
      if (!name || !id) {
        return null;
      }
      return {
        id,
        name,
        args: parseToolArgs(functionRecord?.arguments ?? record.args),
        index:
          typeof record.index === "number" && Number.isFinite(record.index)
            ? record.index
            : index,
      };
    })
    .filter((call): call is ObservedAgentToolCall => call !== null);
}

function extractToolCallsFromContentBlocks(value: unknown) {
  if (!Array.isArray(value)) {
    return [] as ObservedAgentToolCall[];
  }
  return value
    .map((candidate, index): ObservedAgentToolCall | null => {
      const record = toObjectRecord(candidate);
      if (!record) {
        return null;
      }
      const type = typeof record.type === "string" ? record.type : "";
      if (type !== "tool_call" && type !== "tool_use") {
        return null;
      }
      const name =
        typeof record.name === "string"
          ? record.name
          : typeof record.tool_name === "string"
            ? record.tool_name
            : null;
      const id = typeof record.id === "string" ? record.id : null;
      if (!name || !id) {
        return null;
      }
      return {
        id,
        name,
        args: parseToolArgs(record.args ?? record.input),
        index:
          typeof record.index === "number" && Number.isFinite(record.index)
            ? record.index
            : index,
      };
    })
    .filter((call): call is ObservedAgentToolCall => call !== null);
}

function extractToolCallsFromMessage(value: unknown) {
  const record = toObjectRecord(value);
  if (!record) {
    return [] as ObservedAgentToolCall[];
  }
  const directCalls = Array.isArray(record.tool_calls)
    ? record.tool_calls
    : Array.isArray(record.toolCalls)
      ? record.toolCalls
      : [];
  const normalizedDirect = directCalls
    .map((candidate, index): ObservedAgentToolCall | null => {
      const call = toObjectRecord(candidate);
      if (!call) {
        return null;
      }
      const id = typeof call?.id === "string" ? call.id : null;
      const name = typeof call?.name === "string" ? call.name : null;
      if (!id || !name) {
        return null;
      }
      return {
        id,
        name,
        args: parseToolArgs(
          call.args ?? toObjectRecord(call.function)?.arguments,
        ),
        index,
      };
    })
    .filter((call): call is ObservedAgentToolCall => call !== null);
  const contentBlockCalls = [
    ...extractToolCallsFromContentBlocks(record.contentBlocks),
    ...extractToolCallsFromContentBlocks(record.content_blocks),
    ...extractToolCallsFromContentBlocks(record.content),
  ];
  const rawCalls = extractToolCallsFromRawProvider(
    toObjectRecord(record.additional_kwargs)?.tool_calls ??
      toObjectRecord(toObjectRecord(record.lc_kwargs)?.additional_kwargs)
        ?.tool_calls,
  );
  return [...normalizedDirect, ...contentBlockCalls, ...rawCalls];
}

function extractToolCallsFromUpdates(payload: unknown) {
  const updates = toObjectRecord(payload);
  if (!updates) {
    return [] as ObservedAgentToolCall[];
  }
  const calls: ObservedAgentToolCall[] = [];
  for (const value of Object.values(updates)) {
    const update = toObjectRecord(value);
    if (!update) {
      continue;
    }
    const messages = Array.isArray(update.messages) ? update.messages : [];
    for (const message of messages) {
      calls.push(...extractToolCallsFromMessage(message));
    }
  }
  return calls;
}

function rememberObservedToolCalls(
  target: Map<string, ObservedAgentToolCall>,
  calls: ObservedAgentToolCall[],
) {
  for (const call of calls) {
    if (!target.has(call.id)) {
      target.set(call.id, call);
    }
  }
}

function extractHitlInterrupts(payload: unknown) {
  const record = toObjectRecord(payload);
  const interrupts = record?.__interrupt__;
  if (!Array.isArray(interrupts)) {
    return [] as HitlInterruptRequest[];
  }
  return interrupts
    .map((interruptValue): HitlInterruptRequest | null => {
      const interruptRecord = toObjectRecord(interruptValue);
      const value = toObjectRecord(interruptRecord?.value);
      const id =
        typeof interruptRecord?.id === "string" &&
        interruptRecord.id.trim().length > 0
          ? interruptRecord.id.trim()
          : undefined;
      const actionRequestsValue = value?.actionRequests;
      const reviewConfigsValue = value?.reviewConfigs;
      if (
        !Array.isArray(actionRequestsValue) ||
        !Array.isArray(reviewConfigsValue)
      ) {
        return null;
      }
      const actionRequests = actionRequestsValue.map((candidate) => {
        const action = toObjectRecord(candidate);
        return {
          name: typeof action?.name === "string" ? action.name : "",
          args: parseToolArgs(action?.args),
          ...(typeof action?.description === "string"
            ? { description: action.description }
            : {}),
        };
      });
      const reviewConfigs = reviewConfigsValue.map((candidate) => {
        const config = toObjectRecord(candidate);
        const allowed = Array.isArray(config?.allowedDecisions)
          ? config.allowedDecisions.filter(
              (decision): decision is "approve" | "edit" | "reject" =>
                decision === "approve" ||
                decision === "edit" ||
                decision === "reject",
            )
          : [];
        return {
          actionName:
            typeof config?.actionName === "string" ? config.actionName : "",
          allowedDecisions: allowed,
          ...(toObjectRecord(config?.argsSchema)
            ? { argsSchema: toObjectRecord(config?.argsSchema)! }
            : {}),
        };
      });
      if (
        actionRequests.some((request) => request.name.length === 0) ||
        reviewConfigs.some((config) => config.actionName.length === 0)
      ) {
        return null;
      }
      return { ...(id ? { id } : {}), actionRequests, reviewConfigs };
    })
    .filter(
      (interrupt): interrupt is HitlInterruptRequest => interrupt !== null,
    );
}

function matchInterruptedToolCall(input: {
  action: HitlActionRequest;
  index: number;
  observedToolCalls: ObservedAgentToolCall[];
  usedToolCallIds: Set<string>;
}) {
  const matches = input.observedToolCalls.filter(
    (call) =>
      call.name === input.action.name && !input.usedToolCallIds.has(call.id),
  );
  const exact = matches.find((call) =>
    sameToolArgs(call.args, input.action.args),
  );
  const match = exact ?? matches[input.index] ?? matches[0] ?? null;
  if (!match) {
    throw new ContentError(
      500,
      "AGENT_HITL_TOOL_CALL_NOT_FOUND",
      `DeepAgents HITL interrupted ${input.action.name}, but the matching tool call id was not present in the streamed AI message.`,
    );
  }
  input.usedToolCallIds.add(match.id);
  return match;
}

function withHitlEditableArgs(
  confirmation: ToolConfirmationRequest,
  reviewConfig: HitlReviewConfig | undefined,
) {
  if (!reviewConfig || !reviewConfig.allowedDecisions.includes("edit")) {
    return confirmation;
  }
  return {
    ...confirmation,
    editableArgs: {
      value:
        confirmation.editableArgs?.value ??
        confirmation.preview.requestJson ??
        {},
      ...(reviewConfig.argsSchema
        ? { schema: reviewConfig.argsSchema }
        : confirmation.editableArgs?.schema
          ? { schema: confirmation.editableArgs.schema }
          : {}),
    },
  };
}

function connectorHitlActionResumeInput(action: HitlActionRequest) {
  const { connectorId: rawConnectorId, ...requestJson } = action.args;
  return {
    connectorId:
      typeof rawConnectorId === "string" && rawConnectorId.trim().length > 0
        ? rawConnectorId.trim()
        : undefined,
    requestJson,
    toolName: action.name,
  };
}

function isConnectorHitlActionAlreadyApproved(input: {
  action: HitlActionRequest;
  connectorContext: {
    actionExecutionCursor?: ConnectorActionExecutionCursor;
  };
}) {
  return Boolean(
    peekConnectorActionExecutionRef(
      input.connectorContext,
      connectorHitlActionResumeInput(input.action),
    ),
  );
}

function buildAutoApprovedHitlResumeDecisions(input: {
  connectorContext: {
    actionExecutionCursor?: ConnectorActionExecutionCursor;
  };
  hitlInterrupts: HitlInterruptRequest[];
}): ToolApprovalResumeDecision[] | null {
  const decisions: ToolApprovalResumeDecision[] = [];

  for (const interruptRequest of input.hitlInterrupts) {
    for (const action of interruptRequest.actionRequests) {
      if (
        !isConnectorHitlActionAlreadyApproved({
          action,
          connectorContext: input.connectorContext,
        })
      ) {
        return null;
      }
      decisions.push({ type: "approve" });
    }
  }

  return decisions.length > 0 ? decisions : null;
}

async function createHitlConfirmation(input: {
  action: HitlActionRequest;
  connectorContext: {
    actionApprovalCursor?: ConnectorActionApprovalCursor;
    actionExecutionCursor?: ConnectorActionExecutionCursor;
    actionApprovalScope?: string;
    enabledToolNames?: ReadonlySet<string>;
    teamId: string;
    workspaceId: string;
    userId: string;
  };
  reviewConfig?: HitlReviewConfig;
  hitlInterruptId?: string;
  toolCallId: string;
}) {
  const confirmation = input.action.name.startsWith("mcp__")
    ? await mcpService.createApprovalForInterruptedTool({
        workspaceId: input.connectorContext.workspaceId,
        userId: input.connectorContext.userId,
        toolName: input.action.name,
        args: input.action.args,
        toolCallId: input.toolCallId,
      })
    : await createConnectorActionApprovalRequest(input.connectorContext, {
        args: input.action.args,
        toolCallId: input.toolCallId,
        toolName: input.action.name,
      });
  if (!confirmation) {
    throw new ContentError(
      500,
      "AGENT_HITL_CONFIRMATION_UNSUPPORTED",
      `DeepAgents HITL interrupted unsupported tool ${input.action.name}.`,
    );
  }
  const nextConfirmation = withHitlEditableArgs(
    confirmation,
    input.reviewConfig,
  );
  return input.hitlInterruptId
    ? {
        ...nextConfirmation,
        execution: {
          ...nextConfirmation.execution,
          sourceweft: {
            ...(nextConfirmation.execution.sourceweft ?? {}),
            hitlInterruptId: input.hitlInterruptId,
          },
        },
      }
    : nextConfirmation;
}

function commandResumeFromToolApprovalResume(
  resume: ToolApprovalResume,
): ToolApprovalResume | Record<string, ToolApprovalResume> {
  const interruptId = resume.sourceweft?.hitlInterruptId;
  const commandResume = { decisions: resume.decisions };
  return interruptId ? { [interruptId]: commandResume } : commandResume;
}

function commandResumeFromHitlDecisions(input: {
  decisions: ToolApprovalResumeDecision[];
  hitlInterruptId?: string;
}): ToolApprovalResume | Record<string, ToolApprovalResume> {
  const commandResume = { decisions: input.decisions };
  return input.hitlInterruptId
    ? { [input.hitlInterruptId]: commandResume }
    : commandResume;
}

function resolveFinalAssistantText(input: {
  assistantContent: string;
  assistantContentFromUpdates: string | null;
  hasCompletedToolOutput: boolean;
  allowSilentEmptyResponse?: boolean;
}) {
  const assistantContent = input.assistantContent.trim();
  if (assistantContent.length > 0) {
    return assistantContent;
  }

  const assistantContentFromUpdates = input.assistantContentFromUpdates?.trim();
  if (assistantContentFromUpdates && assistantContentFromUpdates.length > 0) {
    return assistantContentFromUpdates;
  }

  if (input.allowSilentEmptyResponse) {
    return "";
  }

  return input.hasCompletedToolOutput
    ? ""
    : "Model returned an empty response.";
}

function shouldSilenceEmptyApprovalResume(input: {
  assistantMessageId: string | null;
  hasCompletedToolOutput: boolean;
  toolApprovalResume: ToolApprovalResume | null;
}) {
  if (!input.assistantMessageId || input.hasCompletedToolOutput) {
    return false;
  }

  return (
    input.toolApprovalResume?.decisions.some(
      (decision) => decision.type === "reject",
    ) ?? false
  );
}

function createTraceSequenceAllocator(input: {
  traceContinuation: PreparedThreadTurn["traceContinuation"];
}) {
  let eventSequence = input.traceContinuation?.maxSequence ?? 0;
  const nextSequence = () => {
    eventSequence += 1;
    return eventSequence;
  };
  const resolveToolCallSequence = (toolCallId: string) =>
    input.traceContinuation?.toolSequenceById[toolCallId] ?? nextSequence();

  return {
    nextSequence,
    resolveToolCallSequence,
  };
}

export const testExports = {
  buildAgentRuntimePrompt,
  createMessageRenderBlockBuilder,
  buildCommandRetryInstruction,
  extractGeneratedImageArtifacts,
  finalizeMessageRenderBlocks,
  getFilesystemToolDescription,
  getFilesystemToolEndTitle,
  getFilesystemToolStartTitle,
  getConnectorToolOutputContentError,
  getConnectorToolErrorTextContentError,
  createModelReasoningSegmentId,
  commandResumeFromToolApprovalResume,
  commandResumeFromHitlDecisions,
  resolveHitlInterruptCheckpoint,
  resolveAgentBaseConfig,
  resolveFinalAssistantText,
  shouldSilenceEmptyApprovalResume,
  createTraceSequenceAllocator,
  resolveToolCommand,
  buildAutoApprovedHitlResumeDecisions,
  isCommandSuccessSatisfied,
};

export function normalizeGeneratedImageProgressEvent(payload: unknown): {
  toolCallId: string;
  tool: string;
  data: Record<string, unknown>;
} | null {
  const record = toObjectRecord(payload);
  if (!record || record.type !== GENERATED_IMAGE_PROGRESS_EVENT_TYPE) {
    return null;
  }

  const toolCallId =
    typeof record.toolCallId === "string" && record.toolCallId.length > 0
      ? record.toolCallId
      : null;
  if (!toolCallId) {
    return null;
  }

  const tool = AGENT_TOOL_NAMES.generateImage;

  return {
    toolCallId,
    tool,
    data: {
      ...record,
      tool,
      toolCallId,
    },
  };
}

function getWebToolStartTitle(toolName: string) {
  if (isWebSearchToolName(toolName)) {
    return "Searching the web";
  }
  if (isWebFetchToolName(toolName)) {
    return "Fetching web pages";
  }
  return null;
}

function getWebToolEndTitle(toolName: string) {
  if (isWebSearchToolName(toolName)) {
    return "Searched the web";
  }
  if (isWebFetchToolName(toolName)) {
    return "Fetched web pages";
  }
  return null;
}

function isMcpToolName(toolName: string) {
  return toolName.startsWith("mcp__");
}

function getMcpToolDisplayName(toolName: string) {
  return toolName
    .replace(/^mcp__/, "")
    .split("__")
    .filter(Boolean)
    .join(".");
}

function getWebToolInputMetadata(
  toolName: string,
  input: Record<string, unknown>,
) {
  if (isWebSearchToolName(toolName)) {
    const query = typeof input.query === "string" ? input.query.trim() : "";
    const fresh = input.fresh === true;
    return {
      ...(query ? { query } : {}),
      ...(fresh ? { fresh: true } : {}),
    };
  }

  if (isWebFetchToolName(toolName)) {
    const urls = extractWebFetchUrls(input);
    const fresh = input.fresh === true;
    return {
      urlCount: urls.length,
      ...(fresh ? { fresh: true } : {}),
    };
  }

  return {};
}

function getWebToolMetadata(output: unknown) {
  const outputText = extractToolOutputText(output);
  const metadata: Record<string, unknown> = {};
  if (!outputText) {
    return metadata;
  }

  const webResultMatches = outputText.match(/<web_result /g);
  const webPageMatches = outputText.match(/<web_page /g);
  const toolErrorMatches = outputText.match(/<web_tool_error /g);
  if (webResultMatches) {
    metadata.resultCount = webResultMatches.length;
  }
  if (toolErrorMatches) {
    metadata.errorCount = toolErrorMatches.length;
  }
  if (webPageMatches) {
    metadata.resultCount = webPageMatches.length;
    metadata.pageCount = webPageMatches.length;
    const errorMatches = outputText.match(/<web_page [^>]* error=/g);
    if (errorMatches) {
      metadata.errorCount = errorMatches.length;
      metadata.successCount = Math.max(
        0,
        webPageMatches.length - errorMatches.length,
      );
    }
  }
  metadata.truncated = outputText.includes("truncated='true'");
  return metadata;
}

function normalizeWebToolOutput(toolName: string, output: unknown) {
  if (!isWebToolName(toolName)) {
    return output;
  }

  const outputText = extractToolOutputText(output);
  if (!outputText) {
    return output;
  }

  const urls = [...outputText.matchAll(/url='([^']+)'/g)]
    .map((match) => match[1])
    .filter((url): url is string => typeof url === "string");
  const webResultMatches = outputText.match(/<web_result /g);
  const webPageMatches = outputText.match(/<web_page /g);
  const errorMatches = outputText.match(/<web_page [^>]* error=/g);
  const toolError = extractWebToolError(outputText);
  const pages = extractWebToolPages(outputText);

  return {
    ...(webResultMatches ? { resultCount: webResultMatches.length } : {}),
    ...(webPageMatches ? { pageCount: webPageMatches.length } : {}),
    ...(errorMatches || toolError
      ? { errorCount: (errorMatches?.length ?? 0) + (toolError ? 1 : 0) }
      : {}),
    ...(toolError ? { error: toolError.error, query: toolError.query } : {}),
    urlCount: urls.length,
    urls: urls.slice(0, 10),
    ...(pages.length > 0 ? { pages } : {}),
    truncated: outputText.includes("truncated='true'"),
  };
}

function extractWebToolError(outputText: string) {
  const match = outputText.match(/<web_tool_error\b([^>]*)>/);
  if (!match) {
    return null;
  }
  const attributes = extractXmlAttributes(match[1] ?? "");
  const error = attributes.error?.trim();
  if (!error) {
    return null;
  }
  const query = attributes.query?.trim();
  return {
    error,
    ...(query ? { query } : {}),
  };
}

function getWebToolOutputError(output: unknown) {
  const record = toObjectRecord(output);
  if (
    record &&
    typeof record.error === "string" &&
    record.error.trim().length > 0
  ) {
    return record.error.trim();
  }
  const pages = Array.isArray(record?.pages) ? record.pages : [];
  if (pages.length > 0) {
    const pageErrors = pages
      .map((page) => {
        const pageRecord = toObjectRecord(page);
        const error = pageRecord?.error;
        return typeof error === "string" && error.trim().length > 0
          ? error.trim()
          : null;
      })
      .filter((error): error is string => error !== null);
    if (pageErrors.length === pages.length) {
      return pageErrors[0] ?? "Web tool failed.";
    }
  }

  const outputText = extractToolOutputText(output);
  if (!outputText) {
    return null;
  }

  return extractWebToolError(outputText)?.error ?? null;
}

function getConnectorToolOutputError(output: unknown) {
  const record = getConnectorToolErrorRecord(output);
  if (
    record &&
    typeof record.message === "string" &&
    record.message.trim().length > 0
  ) {
    return record.message.trim();
  }
  return null;
}

function getConnectorToolErrorRecord(output: unknown) {
  const record = toObjectRecord(output);
  if (record?.type === "connector_tool_error") {
    return record;
  }

  const outputText = extractToolOutputText(output);
  if (!outputText) {
    return null;
  }
  try {
    const parsed = JSON.parse(outputText);
    const parsedRecord = toObjectRecord(parsed);
    return parsedRecord?.type === "connector_tool_error" ? parsedRecord : null;
  } catch {
    return null;
  }
}

function getConnectorToolOutputContentError(output: unknown) {
  const record = getConnectorToolErrorRecord(output);
  const outputText = extractToolOutputText(output) ?? "";
  if (record?.code !== "CONNECTOR_ACTION_NOT_APPROVED") {
    if (
      !outputText.includes("CONNECTOR_ACTION_NOT_APPROVED") &&
      !outputText.includes(
        "Connector action must be approved before execution",
      ) &&
      !outputText.includes(
        "Approved action was not found for this resumed tool call",
      )
    ) {
      return null;
    }
  }
  return new ContentError(
    409,
    "CONNECTOR_ACTION_APPROVAL_MISMATCH",
    "The approved connector action could not be matched during HITL replay. Please retry the latest confirmation.",
  );
}

function getConnectorToolErrorTextContentError(errorText: string) {
  if (
    !errorText.includes("CONNECTOR_ACTION_NOT_APPROVED") &&
    !errorText.includes("Connector action must be approved before execution") &&
    !errorText.includes(
      "Approved action was not found for this resumed tool call",
    )
  ) {
    return null;
  }
  return new ContentError(
    409,
    "CONNECTOR_ACTION_APPROVAL_MISMATCH",
    "The approved connector action could not be matched during HITL replay. Please retry the latest confirmation.",
  );
}

function decodeXmlAttribute(value: string) {
  return value
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function extractXmlAttributes(value: string) {
  const attributes: Record<string, string> = {};
  for (const match of value.matchAll(/([a-zA-Z_][\w:-]*)='([^']*)'/g)) {
    const key = match[1];
    const rawValue = match[2];
    if (key && rawValue !== undefined) {
      attributes[key] = decodeXmlAttribute(rawValue);
    }
  }
  return attributes;
}

function extractWebToolPages(outputText: string) {
  return [...outputText.matchAll(/<(web_result|web_page)\b([^>]*)>/g)]
    .map((match) => {
      const tagName = match[1];
      const attributesText = match[2] ?? "";
      const attributes = extractXmlAttributes(attributesText);
      const url = attributes.url?.trim();
      if (!url) {
        return null;
      }

      const rank = Number(attributes.rank);
      const wordCount = Number(attributes.word_count);
      const title = attributes.title?.trim();
      const error = attributes.error?.trim();
      return {
        url,
        ...(title ? { title } : {}),
        ...(Number.isFinite(rank) ? { rank } : {}),
        ...(attributes.id ? { citation: attributes.id } : {}),
        ...(Number.isFinite(wordCount) ? { wordCount } : {}),
        ...(error ? { error } : {}),
        ...(attributes.truncated === "true" ? { truncated: true } : {}),
        hasContent: tagName === "web_page" || Number.isFinite(wordCount),
      };
    })
    .filter((page): page is NonNullable<typeof page> => page !== null)
    .slice(0, 20);
}

function formatDateInTimeZone(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

const MAX_RUNTIME_SOURCE_REFERENCES = 50;

function escapeRuntimeValue(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function uniqueNonEmpty(values: Array<string | null | undefined>) {
  return Array.from(
    new Set(
      values
        .map((value) => value?.trim() ?? "")
        .filter((value) => value.length > 0),
    ),
  );
}

function readableSourcePath(source: VirtualFsSource) {
  return source.filePath ?? source.readmePath ?? source.dirPath;
}

function formatRuntimeSourceReference(source: VirtualFsSource) {
  const mentionLabels = uniqueNonEmpty([source.title, source.fileName])
    .map((value) => `@${value}`)
    .join(", ");
  const originalFile = source.fileName?.trim();
  const parts = [
    `title="${escapeRuntimeValue(source.title)}"`,
    originalFile ? `original_file="${escapeRuntimeValue(originalFile)}"` : null,
    mentionLabels
      ? `mention_labels="${escapeRuntimeValue(mentionLabels)}"`
      : null,
    `kb_path="${escapeRuntimeValue(readableSourcePath(source))}"`,
    source.sourceType === "directory"
      ? `kb_directory="${escapeRuntimeValue(source.dirPath)}"`
      : null,
    `type="${escapeRuntimeValue(source.sourceType)}"`,
    `chunks="${source.chunkCount}"`,
  ].filter((part): part is string => part !== null);

  return `- ${parts.join(" ")}`;
}

function buildSelectedSourceManifest(input: {
  label?: string;
  sources: VirtualFsSource[];
  omittedCount: number;
}) {
  if (input.sources.length === 0) {
    return "";
  }

  const label = input.label ?? "visible";
  return [
    "<selected_source_manifest>",
    `These are the current turn's ${label} Source Library entries visible under /kb.`,
    "Resolve user @mentions, attachment labels, and filenames against title, original_file, and mention_labels below.",
    "Do not synthesize /work/<filename> for @mentions or source filenames. /work contains only thread Workfiles.",
    ...input.sources.map(formatRuntimeSourceReference),
    input.omittedCount > 0
      ? `- ${input.omittedCount} additional source entries omitted from this manifest; use ls('/kb') if you need to enumerate them.`
      : null,
    "</selected_source_manifest>",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function buildInvokedSkillsRuntimePrompt(input: {
  enabledSkills: PreparedThreadTurn["enabledSkills"];
  invokedSkillIds: string[];
}) {
  if (input.invokedSkillIds.length === 0) {
    return "";
  }
  const invokedSkillIdSet = new Set(input.invokedSkillIds);
  const invokedSkills = input.enabledSkills.filter((skill) =>
    invokedSkillIdSet.has(skill.workspaceSkillId),
  );
  if (invokedSkills.length === 0) {
    return "";
  }

  return [
    "<user_invoked_skills>",
    "The user explicitly invoked these skills for this turn. This is a strong instruction, not a suggestion: apply the loaded SKILL.md workflow when answering unless it conflicts with higher-priority system rules. Use /skills only for supporting files or additional details.",
    ...invokedSkills.flatMap((skill) => {
      const skillPath = `/skills/${skill.name}/SKILL.md`;
      const skillContent = skill.files.find(
        (file) => file.path === "SKILL.md",
      )?.contentText;
      const header = [
        `- name="${escapeRuntimeValue(skill.name)}"`,
        `description="${escapeRuntimeValue(skill.description)}"`,
        `skill_path="${escapeRuntimeValue(skillPath)}"`,
      ].join(" ");
      const safeContent = skillContent
        ? sanitizeNonCitableCitationMarkers(skillContent).trim()
        : "";
      if (!safeContent) {
        return [
          header,
          `  Could not preload SKILL.md content. Read ${skillPath} from /skills before answering.`,
        ];
      }
      return [
        header,
        `  <skill_content path="${escapeRuntimeValue(skillPath)}">`,
        safeContent,
        "  </skill_content>",
      ];
    }),
    "</user_invoked_skills>",
  ].join("\n");
}

function buildAgentRuntimePrompt(input: {
  availableWebTools?: string[];
  availableArtifactTools?: string[];
  availableMcpTools?: string[];
  artifactIntent?: PreparedThreadTurn["artifactIntent"];
  commandSuccessCriteria?: PreparedThreadTurn["commandSuccessCriteria"];
  enabledSkills?: PreparedThreadTurn["enabledSkills"];
  invokedSkillIds?: string[];
  timezone: string;
  selectedSources?: VirtualFsSource[];
  selectedSourcesOmitted?: number;
}) {
  const timeZone = input.timezone;
  const currentDate = formatDateInTimeZone(new Date(), timeZone);
  const lines = [
    `Current date: ${currentDate}.`,
    `Current timezone: ${timeZone}.`,
  ];
  const sourceManifest = buildSelectedSourceManifest({
    sources: input.selectedSources ?? [],
    omittedCount: input.selectedSourcesOmitted ?? 0,
  });
  if (sourceManifest) {
    lines.push(sourceManifest);
  }
  const invokedSkillsPrompt = buildInvokedSkillsRuntimePrompt({
    enabledSkills: input.enabledSkills ?? [],
    invokedSkillIds: input.invokedSkillIds ?? [],
  });
  if (invokedSkillsPrompt) {
    lines.push(invokedSkillsPrompt);
  }
  const commandSuccessInstruction = buildCommandSuccessInstruction(
    input.commandSuccessCriteria ?? { kind: "none" },
  );
  if (commandSuccessInstruction) {
    lines.push(
      "<sourceweft_command_success>",
      commandSuccessInstruction,
      "</sourceweft_command_success>",
    );
  }

  const availableWebTools = input.availableWebTools ?? [];
  if (availableWebTools.length > 0) {
    lines.push(
      `Available public web tools this turn: ${availableWebTools.join(", ")}.`,
      "For workspace-specific or selected-source questions, use selected source tools first. Use web tools only when the user explicitly asks for internet information, asks about current public facts, or selected sources do not contain enough evidence.",
      `When a date qualifier is useful, use the current date/year from this runtime context: ${currentDate}.`,
    );
  }

  const availableArtifactTools = input.availableArtifactTools ?? [];
  if (
    availableArtifactTools.length > 0 &&
    input.artifactIntent?.kind === "image"
  ) {
    const config = input.artifactIntent.config;
    lines.push(
      `Available artifact tools this turn: ${availableArtifactTools.join(", ")}.`,
      `Image generation defaults: aspect_ratio=${config.aspectRatio}, quality=${config.quality}, style=${config.style}.`,
      `${AGENT_TOOL_NAMES.generateImage} is available in auto mode. Use it when the user asks you to create a new visual artifact or deliverable; otherwise answer normally.`,
      `For ambiguous requests, decide semantically from the user's goal rather than matching literal keywords. If the user expects a kept visual output, call ${AGENT_TOOL_NAMES.generateImage}.`,
      "If the prompt is missing essential visual details for a requested image, make a reasonable concise prompt instead of asking a separate confirmation.",
      `Never claim an image was created unless ${AGENT_TOOL_NAMES.generateImage} completed successfully.`,
      `After ${AGENT_TOOL_NAMES.generateImage} succeeds, keep the final answer concise. The application displays the generated image automatically; do not include image markdown or raw artifact URLs.`,
    );
  }

  const availableMcpTools = input.availableMcpTools ?? [];
  if (availableMcpTools.length > 0) {
    lines.push(
      `Available MCP tools this turn: ${availableMcpTools.join(", ")}.`,
      "MCP tools may call external services configured by the workspace. Use them only when they are relevant to the user's request.",
    );
  }

  return lines.join("\n");
}

function extractReasoningSummaryFromProviderFields(
  providerFields: Record<string, unknown> | undefined,
) {
  if (!providerFields) {
    return null;
  }

  const candidates = [
    providerFields.reasoning_summary,
    providerFields.reasoningSummary,
    providerFields.reasoning,
    providerFields.summary,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }

    const record = toObjectRecord(candidate);
    if (record) {
      const text =
        typeof record.summary === "string"
          ? record.summary
          : typeof record.text === "string"
            ? record.text
            : typeof record.content === "string"
              ? record.content
              : null;
      if (text && text.trim().length > 0) {
        return text.trim();
      }
    }
  }

  return null;
}

export async function* invokeDeepAgentTurn(input: {
  prepared: PreparedThreadTurn;
  billing: ContentBillingPort;
  llm?: LlmExecutionConfig;
  traceContext?: TraceContext;
}): AsyncGenerator<DeepAgentTurnEvent> {
  const retrievalCallsById = new Map<string, RetrievalCallTrace>();
  const retrievalsByToolCallId = new Map<
    string,
    Awaited<ReturnType<typeof runToolRetrieval>>
  >();
  const retrievalCallOrder: string[] = [];
  const toolCallsById = new Map<string, ToolCallTrace>();
  const toolCallOrder: string[] = [];
  const toolStartedAtById = new Map<string, number>();
  const observedToolCallsById = new Map<string, ObservedAgentToolCall>();
  const thinkingStepsById = new Map<string, ThinkingStepTrace>();
  const thinkingStepOrder: string[] = [];
  const reasoningSegments: DeepAgentTurnOutcome["reasoningSegments"] = [];
  const renderBlocks = createMessageRenderBlockBuilder();
  const runStartedAt = Date.now();
  const citationRegistry = new AgentCitationRegistry();
  let latestToolRetrieval: Awaited<ReturnType<typeof runToolRetrieval>> | null =
    null;
  let assistantContent = "";
  let assistantContentFromUpdates: string | null = null;
  let usage: DeepAgentTurnOutcome["usage"];
  let finishReason: string | undefined;
  let modelReasoning: string | undefined;
  let providerFields: Record<string, unknown> | undefined;
  let hasStreamedText = false;
  let hasTextSinceLastToolBoundary = false;
  let lastEmittedCitationCount = 0;
  const traceSequenceAllocator = createTraceSequenceAllocator({
    traceContinuation: input.prepared.traceContinuation,
  });
  let currentReasoningSegment:
    | DeepAgentTurnOutcome["reasoningSegments"][number]
    | null = null;
  let nextReasoningContext:
    | { phase: "initial" }
    | { phase: "after_tool"; toolCallId: string; tool: string } = {
    phase: "initial",
  };

  const { nextSequence, resolveToolCallSequence } = traceSequenceAllocator;

  const collectRetrievalCalls = () =>
    retrievalCallOrder
      .map((callId) => retrievalCallsById.get(callId))
      .filter((call): call is RetrievalCallTrace => Boolean(call));

  const collectToolCalls = () =>
    toolCallOrder
      .map((callId) => toolCallsById.get(callId))
      .filter((call): call is ToolCallTrace => Boolean(call))
      .map((call) => {
        if (call.status !== "running") {
          return call;
        }

        const startedAt = toolStartedAtById.get(call.id);
        return {
          ...call,
          status: "completed" as const,
          latencyMs:
            call.latencyMs ??
            (typeof startedAt === "number" ? Date.now() - startedAt : null),
        };
      });

  const setThinkingStep = (step: Omit<ThinkingStepTrace, "sequence">) => {
    const existing = thinkingStepsById.get(step.id);
    return upsertThinkingStep({
      stepsById: thinkingStepsById,
      stepOrder: thinkingStepOrder,
      step: {
        ...step,
        sequence: existing?.sequence ?? nextSequence(),
      },
    });
  };

  const appendReasoningSegment = (text: string) => {
    if (!currentReasoningSegment) {
      currentReasoningSegment = {
        id: createModelReasoningSegmentId({
          runTraceId: input.prepared.runTraceId,
          index: reasoningSegments.length + 1,
        }),
        text: "",
        sequence: nextSequence(),
        durationMs: 0,
        phase: nextReasoningContext.phase,
        ...(nextReasoningContext.phase === "after_tool"
          ? {
              toolCallId: nextReasoningContext.toolCallId,
              tool: nextReasoningContext.tool,
            }
          : {}),
      };
      reasoningSegments.push(currentReasoningSegment);
    }

    currentReasoningSegment.durationMs = Date.now() - runStartedAt;
    currentReasoningSegment.text =
      appendReasoningChunk(currentReasoningSegment.text, text) ??
      currentReasoningSegment.text;

    return currentReasoningSegment;
  };

  const getNewCitationSnapshot = () => {
    const citations = citationRegistry.list();
    if (citations.length <= lastEmittedCitationCount) {
      return null;
    }

    lastEmittedCitationCount = citations.length;
    return citations;
  };

  const recordRetrieval = (input: {
    callId: string;
    query: string;
    retrieval: Awaited<ReturnType<typeof runToolRetrieval>>;
    latencyMs: number;
  }) => {
    latestToolRetrieval = input.retrieval;

    if (!retrievalCallsById.has(input.callId)) {
      retrievalCallOrder.push(input.callId);
    }

    const retrievalCall: RetrievalCallTrace = {
      id: input.callId,
      tool: AGENT_TOOL_NAMES.searchSources,
      query: input.query,
      hitCount: input.retrieval.fusedCandidates.length,
      latencyMs: input.latencyMs,
    };
    retrievalCallsById.set(input.callId, retrievalCall);
    retrievalsByToolCallId.set(input.callId, input.retrieval);

    return new Map(
      input.retrieval.fusedCandidates.map((candidate) => {
        const citation = citationRegistry.addRetrievalCandidate(candidate);
        return [candidate.chunkId, citation] as const;
      }),
    );
  };

  const buildRetrievalChunks = (input: {
    retrieval: Awaited<ReturnType<typeof runToolRetrieval>>;
    citationByChunkId: Map<
      string,
      ReturnType<AgentCitationRegistry["addRetrievalCandidate"]>
    >;
  }) =>
    input.retrieval.fusedCandidates.map((candidate, index) => ({
      citation:
        input.citationByChunkId.get(candidate.chunkId)?.citation ??
        `c${index + 1}`,
      chunkId: candidate.chunkId,
      content: candidate.content,
      sourceTitle: input.citationByChunkId.get(candidate.chunkId)?.sourceTitle,
    }));

  const retrievalTool = createRetrievalTool({
    searchSources: async (query, runtime) => {
      const retrievalStartedAt = Date.now();
      const retrieval = await runToolRetrieval({
        prepared: input.prepared,
        query,
        llm: input.llm,
        traceContext:
          runtime?.toolCallId && input.traceContext
            ? {
                ...input.traceContext,
                parentSpanId: resolveToolCallId({
                  toolCallId: runtime.toolCallId,
                  toolName: AGENT_TOOL_NAMES.searchSources,
                  fallbackIndex: retrievalCallOrder.length + 1,
                }),
              }
            : input.traceContext,
      });
      const callId = resolveToolCallId({
        toolCallId: runtime?.toolCallId,
        toolName: AGENT_TOOL_NAMES.searchSources,
        fallbackIndex: retrievalCallOrder.length + 1,
      });
      const citationByChunkId = recordRetrieval({
        callId,
        query,
        retrieval,
        latencyMs: Date.now() - retrievalStartedAt,
      });
      return buildRetrievalChunks({ retrieval, citationByChunkId });
    },
  });
  const webProvider = createDefaultWebProvider();
  const webSearchAvailable =
    input.prepared.webSearchEnabled &&
    !isToolDenied(input.prepared, AGENT_TOOL_NAMES.webSearch);
  const webTools = webProvider
    ? createWebTools({
        provider: webProvider,
        citationRegistry,
        searchEnabled: webSearchAvailable,
      }).filter((tool) => !isToolDenied(input.prepared, tool.name))
    : [];
  const artifactTools =
    input.prepared.artifactIntent.shouldInjectTool &&
    input.prepared.imageProfile &&
    !isToolDenied(input.prepared, AGENT_TOOL_NAMES.generateImage)
      ? [
          createGenerateImageTool({
            teamId: input.prepared.workspace.organizationId,
            workspaceId: input.prepared.workspace.id,
            threadId: input.prepared.thread.id,
            userId: input.prepared.userId,
            userMessageId: input.prepared.userMessage.id,
            traceId: input.traceContext?.traceId,
            parentSpanId: input.traceContext?.parentSpanId,
            profile: input.prepared.imageProfile.profile,
            execution: input.prepared.generateImageTool?.execution,
            config: input.prepared.artifactIntent.config,
            billing: input.billing,
          }),
        ]
      : [];
  const actionApprovalCursor: ConnectorActionApprovalCursor = { value: 0 };
  const actionApprovalScope =
    input.prepared.agentMode === "replay" && input.prepared.agentBaseCheckpoint
      ? buildConnectorActionApprovalScope({
          threadId: input.prepared.agentBaseCheckpoint.threadId,
          checkpointId: input.prepared.agentBaseCheckpoint.checkpointId,
        })
      : buildConnectorActionApprovalScope({
          threadId: input.prepared.agentRunThreadId,
        });
  const actionExecutionCursor: ConnectorActionExecutionCursor | undefined =
    input.prepared.toolApprovalResume?.sourceweft?.connectorActions?.length
      ? {
          refs: input.prepared.toolApprovalResume.sourceweft.connectorActions,
          value: 0,
        }
      : undefined;
  const connectorToolContext = {
    actionApprovalCursor,
    actionExecutionCursor,
    actionApprovalScope,
    teamId: input.prepared.workspace.organizationId,
    workspaceId: input.prepared.workspace.id,
    userId: input.prepared.userId,
  };
  const connectorActionTools = filterAllowedTools(
    input.prepared,
    await createConnectorActionTools(connectorToolContext),
  );
  const toolCommand = resolveToolCommand(input.prepared);
  if (toolCommand?.name === AGENT_TOOL_NAMES.generateImage) {
    const generateImageTool = artifactTools.find(
      (candidate) => candidate.name === AGENT_TOOL_NAMES.generateImage,
    );
    if (!generateImageTool || toolCommand.prompt.length === 0) {
      const errorText = !generateImageTool
        ? "Image generation is not available for this turn."
        : "Image prompt is empty.";
      yield {
        type: "text-delta",
        delta: sanitizeSseValue(errorText),
      };
      yield {
        type: "done",
        outcome: {
          assistantContent: errorText,
          usage,
          retrieval: null,
          citations: [],
          availableCitations: [],
          retrievalCalls: [],
          toolCalls: [],
          thinkingSteps: [],
          reasoningSegments,
          agentCheckpoint: {
            beforeInput: null,
            beforeAssistant: null,
            resume: null,
            final: null,
          },
        },
      };
      return;
    }

    const toolCallId = resolveToolCallId({
      toolName: AGENT_TOOL_NAMES.generateImage,
      fallbackIndex: 1,
    });
    const normalizedInput = {
      prompt: toolCommand.prompt,
      title: compactTraceText(toolCommand.prompt, 80),
    };
    const startedAt = Date.now();
    const imageConfig =
      input.prepared.artifactIntent.kind === "image"
        ? input.prepared.artifactIntent.config
        : null;
    const initialToolCall: ToolCallTrace = {
      id: toolCallId,
      tool: AGENT_TOOL_NAMES.generateImage,
      input: normalizedInput,
      output: null,
      status: "running",
      latencyMs: null,
      error: null,
      sequence: resolveToolCallSequence(toolCallId),
    };
    toolCallOrder.push(toolCallId);
    toolCallsById.set(toolCallId, initialToolCall);
    toolStartedAtById.set(toolCallId, startedAt);
    if (input.traceContext) {
      await startSpan({
        ...input.traceContext,
        spanId: toolCallId,
        parentSpanId: input.traceContext.parentSpanId,
        name: `tool:${AGENT_TOOL_NAMES.generateImage}`,
        kind: "tool",
        operation: "tool.call",
        input: normalizedInput,
        metadata: {
          toolName: AGENT_TOOL_NAMES.generateImage,
          sequence: initialToolCall.sequence,
          source: "slash_command",
        },
      });
    }
    renderBlocks.appendGeneratedImage(toolCallId);
    yield {
      type: "tool-call-start",
      id: toolCallId,
      tool: AGENT_TOOL_NAMES.generateImage,
      input: normalizedInput,
      toolCall: initialToolCall,
    };

    let finalToolCall = initialToolCall;
    const emitDirectProgress = (
      stage: "preparing" | "generating" | "ready",
      metadata?: Record<string, unknown>,
    ) => {
      const progressEvent = normalizeGeneratedImageProgressEvent({
        type: GENERATED_IMAGE_PROGRESS_EVENT_TYPE,
        toolCallId,
        tool: AGENT_TOOL_NAMES.generateImage,
        prompt: normalizedInput.prompt,
        stage,
        title: normalizedInput.title,
        ...(imageConfig
          ? {
              aspectRatio: imageConfig.aspectRatio,
              quality: imageConfig.quality,
              style: imageConfig.style,
            }
          : {}),
        ...metadata,
      });
      if (!progressEvent) {
        return;
      }
      const currentToolCall = toolCallsById.get(toolCallId) ?? finalToolCall;
      const nextToolCall: ToolCallTrace = {
        ...currentToolCall,
        output: progressEvent.data,
        status: stage === "ready" ? currentToolCall.status : "running",
        error: null,
      };
      toolCallsById.set(toolCallId, nextToolCall);
      finalToolCall = nextToolCall;
      return {
        type: "tool-call-event" as const,
        id: toolCallId,
        tool: AGENT_TOOL_NAMES.generateImage,
        data: progressEvent.data,
        toolCall: nextToolCall,
      };
    };
    const preparingEvent = emitDirectProgress("preparing");
    if (preparingEvent) {
      yield preparingEvent;
    }
    try {
      const generatingEvent = emitDirectProgress("generating", {
        providerModel:
          input.prepared.generateImageTool?.execution?.providerModel ??
          input.prepared.generateImageTool?.execution?.modelAlias ??
          input.prepared.imageProfile?.profile.modelAlias,
      });
      if (generatingEvent) {
        yield generatingEvent;
      }
      const output = await generateImageTool.invoke(normalizedInput, {
        toolCall: { id: toolCallId },
      } as never);
      const latencyMs = Date.now() - startedAt;
      const normalizedOutput = normalizeToolOutputForObservability(
        AGENT_TOOL_NAMES.generateImage,
        output,
      );
      finalToolCall = {
        ...(toolCallsById.get(toolCallId) ?? initialToolCall),
        output: normalizedOutput,
        status: "completed",
        latencyMs,
        error: null,
      };
      toolCallsById.set(toolCallId, finalToolCall);
      const readyEvent = emitDirectProgress("ready");
      if (readyEvent) {
        finalToolCall = {
          ...readyEvent.toolCall,
          output: normalizedOutput,
          status: "completed",
          latencyMs,
          error: null,
        };
        toolCallsById.set(toolCallId, finalToolCall);
        yield {
          ...readyEvent,
          toolCall: finalToolCall,
        };
      }
      if (input.traceContext) {
        await endSpan({
          traceId: input.traceContext.traceId,
          teamId: input.traceContext.teamId,
          workspaceId: input.traceContext.workspaceId,
          spanId: toolCallId,
          status: "ok",
          latencyMs,
          output: normalizedOutput,
          metadata: {
            toolName: AGENT_TOOL_NAMES.generateImage,
            source: "slash_command",
          },
        });
      }
      yield {
        type: "tool-call-result",
        id: toolCallId,
        tool: AGENT_TOOL_NAMES.generateImage,
        input: normalizedInput,
        output: normalizedOutput,
        latencyMs,
        toolCall: finalToolCall,
      };
      yield {
        type: "tool-call-end",
        id: toolCallId,
        tool: AGENT_TOOL_NAMES.generateImage,
        latencyMs,
        status: "completed",
        toolCall: finalToolCall,
      };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const errorText = normalizeErrorText(error);
      finalToolCall = {
        ...initialToolCall,
        status: "error",
        latencyMs,
        error: errorText,
      };
      toolCallsById.set(toolCallId, finalToolCall);
      if (input.traceContext) {
        await endSpan({
          traceId: input.traceContext.traceId,
          teamId: input.traceContext.teamId,
          workspaceId: input.traceContext.workspaceId,
          spanId: toolCallId,
          status: "error",
          latencyMs,
          errorMessage: errorText,
          metadata: {
            toolName: AGENT_TOOL_NAMES.generateImage,
            source: "slash_command",
          },
        });
      }
      yield {
        type: "tool-call-error",
        id: toolCallId,
        tool: AGENT_TOOL_NAMES.generateImage,
        input: normalizedInput,
        error: errorText,
        latencyMs,
        toolCall: finalToolCall,
      };
      yield {
        type: "tool-call-end",
        id: toolCallId,
        tool: AGENT_TOOL_NAMES.generateImage,
        latencyMs,
        status: "error",
        toolCall: finalToolCall,
      };
    }

    const commandSatisfied = isCommandSuccessSatisfied({
      criteria: input.prepared.commandSuccessCriteria,
      toolCalls: [finalToolCall],
    });
    const assistantText = commandSatisfied
      ? "Image artifact created."
      : finalToolCall.error
        ? `Command failed because ${finalToolCall.error}`
        : commandSuccessFailureText(input.prepared.commandSuccessCriteria, [
            finalToolCall,
          ]);
    if (!commandSatisfied) {
      renderBlocks.appendText(assistantText);
      yield {
        type: "text-delta",
        delta: sanitizeSseValue(assistantText),
      };
    }
    const finalRenderBlocks = finalizeMessageRenderBlocks({
      blocks: commandSatisfied ? renderBlocks.list() : [],
      finalText: assistantText,
    });
    yield {
      type: "done",
      outcome: {
        assistantContent: assistantText,
        usage,
        retrieval: null,
        citations: [],
        availableCitations: [],
        retrievalCalls: [],
        toolCalls: [finalToolCall],
        ...(commandSatisfied
          ? {}
          : { finishReason: "command_success_criteria_failed" }),
        ...(finalRenderBlocks.length > 0
          ? { renderBlocks: finalRenderBlocks }
          : {}),
        thinkingSteps: [],
        reasoningSegments,
        agentCheckpoint: {
          beforeInput: null,
          beforeAssistant: null,
          resume: null,
          final: null,
        },
      },
    };
    return;
  }
  const runtimeSourceReferences =
    input.prepared.sourceIds.length > 0
      ? await listVirtualFsSources({
          teamId: input.prepared.workspace.organizationId,
          workspaceId: input.prepared.workspace.id,
          sourceIds: input.prepared.sourceIds,
          limit: MAX_RUNTIME_SOURCE_REFERENCES + 1,
        }).catch((error) => {
          logger.warn("Failed to build selected source runtime manifest", {
            teamId: input.prepared.workspace.organizationId,
            workspaceId: input.prepared.workspace.id,
            sourceCount: input.prepared.sourceIds.length,
            error: error instanceof Error ? error.message : String(error),
          });
          return [] as VirtualFsSource[];
        })
      : [];
  const mentionedSourceReferences =
    input.prepared.effectiveMentionedSourceIds.length > 0
      ? await listVirtualFsSources({
          teamId: input.prepared.workspace.organizationId,
          workspaceId: input.prepared.workspace.id,
          sourceIds: input.prepared.effectiveMentionedSourceIds,
          limit: MAX_RUNTIME_SOURCE_REFERENCES + 1,
        }).catch((error) => {
          logger.warn("Failed to build mentioned source runtime manifest", {
            teamId: input.prepared.workspace.organizationId,
            workspaceId: input.prepared.workspace.id,
            sourceCount: input.prepared.effectiveMentionedSourceIds.length,
            error: error instanceof Error ? error.message : String(error),
          });
          return [] as VirtualFsSource[];
        })
      : [];
  const runtimeSourcesById = new Map<string, VirtualFsSource>();
  for (const source of [
    ...mentionedSourceReferences,
    ...runtimeSourceReferences,
  ]) {
    runtimeSourcesById.set(source.sourceId, source);
  }
  const runtimeSources = Array.from(runtimeSourcesById.values());
  const visibleSources = runtimeSources.slice(0, MAX_RUNTIME_SOURCE_REFERENCES);
  const mcpToolSelection = input.prepared.mcpTools;
  const mcpToolRuntime =
    mcpToolSelection.enabled !== false && mcpToolSelection.installIds?.length
      ? await mcpService.buildLangChainToolsForTurn({
          workspaceId: input.prepared.workspace.id,
          userId: input.prepared.userId,
          threadId: input.prepared.thread.id,
          runId: input.prepared.runTraceId,
          installIds: mcpToolSelection.installIds,
          toolIds: mcpToolSelection.toolIds,
        })
      : null;
  const mcpTools = mcpToolRuntime?.tools ?? [];
  const runtimePrompt = buildAgentRuntimePrompt({
    availableWebTools: webTools.map((tool) => tool.name),
    availableArtifactTools: artifactTools.map((tool) => tool.name),
    availableMcpTools: mcpTools.map((tool) => tool.name),
    artifactIntent: input.prepared.artifactIntent,
    commandSuccessCriteria: input.prepared.commandSuccessCriteria,
    enabledSkills: input.prepared.enabledSkills,
    invokedSkillIds: input.prepared.invokedSkillIds,
    timezone: input.prepared.timezone,
    selectedSources: visibleSources,
    selectedSourcesOmitted: Math.max(
      0,
      runtimeSources.length - visibleSources.length,
    ),
  });

  const databaseBackend = new DatabaseKnowledgeBackend({
    teamId: input.prepared.workspace.organizationId,
    workspaceId: input.prepared.workspace.id,
    sourceIds: Array.from(
      new Set([
        ...input.prepared.sourceIds,
        ...input.prepared.effectiveMentionedSourceIds,
      ]),
    ),
    citationRegistry,
  });
  const workingFilesBackend = new WorkingFilesBackend({
    teamId: input.prepared.workspace.organizationId,
    workspaceId: input.prepared.workspace.id,
    threadId: input.prepared.thread.id,
    userId: input.prepared.userId,
    citationRegistry,
  });
  const skillsBackend =
    input.prepared.enabledSkills.length > 0
      ? new SelectedSkillsBackend(input.prepared.enabledSkills)
      : null;
  const filesystemMounts = createDefaultFilesystemMounts({
    skillsEnabled: Boolean(skillsBackend),
  });
  const backend = new MountedAgentFilesystemBackend({
    knowledge: databaseBackend,
    working: workingFilesBackend,
    skills: skillsBackend,
    mounts: filesystemMounts,
  });

  const agent = await createThreadAgent({
    modelAlias: input.prepared.modelAlias,
    providerModel: input.prepared.providerModel,
    gatewayConfigId: input.prepared.chatProfile.gatewayConfigId,
    tools: [
      ...filterAllowedTools(input.prepared, [retrievalTool]),
      ...webTools,
      ...artifactTools,
      ...connectorActionTools,
      ...mcpTools,
    ],
    backend,
    filesystemMounts,
    skills: skillsBackend ? ["/skills/"] : undefined,
    runtimePrompt,
    chatProfileConfig: input.prepared.chatProfile.configJson,
    contextCompressionReportKey: input.prepared.userMessage.id,
    traceContext: input.traceContext,
    execution: {
      executionMode: input.llm?.executionMode,
      profileAlias:
        input.llm?.executionMode === "BYOK"
          ? undefined
          : input.prepared.profileAlias,
      providerHint: input.llm?.providerHint,
      byokModelId: input.llm?.byokModelId,
      credentialId: input.llm?.credentialId,
      byok: input.llm?.byok,
      thinking: input.llm?.thinking,
      metadata: {
        traceId: input.traceContext?.traceId,
        parentSpanId: input.traceContext?.parentSpanId,
        ...(input.llm?.executionMode === "BYOK"
          ? {}
          : { profileAlias: input.prepared.profileAlias }),
        modelAlias: input.prepared.modelAlias,
        providerModel: input.llm?.providerModel ?? input.prepared.providerModel,
        ...(input.llm?.executionMode === "BYOK"
          ? {
              executionMode: "BYOK",
              byokModelId: input.llm.byokModelId,
              credentialId: input.llm.credentialId,
              keySource: "byokCredential",
            }
          : { executionMode: input.llm?.executionMode ?? "GLOBAL" }),
        teamId: input.prepared.workspace.organizationId,
        workspaceId: input.prepared.workspace.id,
        userId: input.prepared.userId,
        threadId: input.prepared.thread.id,
        messageId: input.prepared.userMessage.id,
        observationName: "agent_generation",
        feature: "chat",
        team_id: input.prepared.workspace.organizationId,
        workspace_id: input.prepared.workspace.id,
        user_id: input.prepared.userId,
        thread_id: input.prepared.thread.id,
        message_id: input.prepared.userMessage.id,
        invoked_skill_ids: input.prepared.invokedSkillIds,
        selected_skill_ids: input.prepared.selectedSkillIds,
        skill_ids: input.prepared.skillIds,
        selected_skill_count: input.prepared.enabledSkills.length,
      },
    },
    interruptOn: {
      ...(mcpToolRuntime?.interruptOn ?? {}),
      ...createConnectorActionInterruptConfigs(),
    },
  });

  const agentMessages = [
    {
      role: "user" as const,
      content: input.prepared.agentMessageContent,
    },
  ];

  const baseConfig = resolveAgentBaseConfig({
    agentBaseCheckpoint: input.prepared.agentBaseCheckpoint,
    agentMode: input.prepared.agentMode,
    agentRunThreadId: input.prepared.agentRunThreadId,
  });
  const beforeInputState =
    input.prepared.agentMode === "continue"
      ? await getAgentStateOrNull(agent, baseConfig as AgentRunnableConfig)
      : null;
  const beforeInputCheckpoint =
    input.prepared.agentMode === "fork"
      ? input.prepared.agentBaseCheckpoint
      : checkpointRefFromConfig(
          (beforeInputState as { config?: unknown } | null)?.config,
        );
  let beforeAssistantCheckpoint =
    input.prepared.agentMode === "replay"
      ? input.prepared.agentBaseCheckpoint
      : null;
  let finalCheckpoint: AgentCheckpointRef | null = null;

  const runConfig = {
    ...baseConfig,
    configurable: {
      ...((baseConfig as { configurable?: Record<string, unknown> })
        .configurable ?? {}),
      team_id: input.prepared.workspace.organizationId,
      workspace_id: input.prepared.workspace.id,
      user_id: input.prepared.userId,
      sourceweft_thread_id: input.prepared.thread.id,
      invoked_skill_ids: input.prepared.invokedSkillIds,
      selected_skill_ids: input.prepared.selectedSkillIds,
      skill_ids: input.prepared.skillIds,
      selected_skill_count: input.prepared.enabledSkills.length,
    },
    streamMode: ["messages", "tools", "updates", "checkpoints", "custom"],
  } satisfies AgentRunnableConfig;
  const runAgentStream = (messages: typeof agentMessages) =>
    agent.stream({ messages }, runConfig as AgentRunnableConfig) as Promise<
      AsyncGenerator<unknown>
    >;

  if (input.prepared.enabledSkills.length > 0) {
    yield {
      type: "thinking-step",
      step: setThinkingStep({
        id: "selected-skills",
        kind: "state",
        title: "Loaded skills",
        status: "completed",
        items: input.prepared.enabledSkills.map((skill) => skill.name),
        description: `${input.prepared.enabledSkills.length} skill${input.prepared.enabledSkills.length === 1 ? "" : "s"} available under /skills.`,
        metadata: {
          invokedSkillIds: input.prepared.invokedSkillIds,
          selectedSkillIds: input.prepared.selectedSkillIds,
          skillIds: input.prepared.skillIds,
          skillNames: input.prepared.enabledSkills.map((skill) => skill.name),
        },
      }),
    };
  }

  const suppressModelReasoning = input.llm?.thinking?.mode === "off";

  try {
    let stream =
      input.prepared.agentMode === "replay"
        ? input.prepared.toolApprovalResume
          ? await agent.stream(
              new Command({
                resume: commandResumeFromToolApprovalResume(
                  input.prepared.toolApprovalResume,
                ),
              }),
              runConfig as AgentRunnableConfig,
            )
          : (() => {
              throw new ContentError(
                400,
                "AGENT_HITL_RESUME_REQUIRED",
                "DeepAgents HITL replay requires a resume decision payload.",
              );
            })()
        : await runAgentStream(agentMessages);
    let retryAttempted = false;
    let autoApprovedHitlResumeCount = 0;
    const maxAutoApprovedHitlResumes = Math.max(
      1,
      input.prepared.toolApprovalResume?.sourceweft?.connectorActions
        ?.length ?? 0,
    );
    streamLoop: while (true) {
      for await (const streamChunk of stream as AsyncGenerator<unknown>) {
        if (!Array.isArray(streamChunk) || streamChunk.length < 2) {
          continue;
        }

        const mode = streamChunk[0];
        const payload = streamChunk[1];

        if (mode === "checkpoints") {
          const checkpoint = checkpointRefFromConfig(
            (toObjectRecord(payload) ?? {}).config,
          );
          if (checkpoint) {
            if (
              !beforeAssistantCheckpoint &&
              checkpointHasPendingTasks(payload)
            ) {
              beforeAssistantCheckpoint = checkpoint;
            }
            finalCheckpoint = checkpoint;
          }
          continue;
        }

        if (mode === "messages") {
          if (!Array.isArray(payload) || payload.length < 1) {
            continue;
          }

          const messageChunk = payload[0];
          const messageMetadata = payload[1];
          rememberObservedToolCalls(
            observedToolCallsById,
            extractToolCallsFromMessage(messageChunk),
          );
          usage = addUsage(usage, extractUsageFromMessageChunk(messageChunk));
          finishReason =
            extractFinishReasonFromMessageChunk(messageChunk) ?? finishReason;
          providerFields =
            extractProviderFieldsFromMessageChunk(messageChunk) ??
            providerFields;
          const nextReasoning =
            extractReasoningFromMessageChunk(messageChunk) ??
            extractReasoningFromMessageChunk(messageMetadata) ??
            extractReasoningFromMessageChunk(payload);
          if (nextReasoning && !suppressModelReasoning) {
            modelReasoning = appendReasoningChunk(
              modelReasoning,
              nextReasoning,
            );
            const segment = appendReasoningSegment(nextReasoning);
            yield {
              type: "reasoning",
              reasoning: nextReasoning,
              segment,
            };
          }
          const deltas = extractTextDeltasFromMessageChunk(messageChunk);
          for (const delta of deltas) {
            if (!delta) {
              continue;
            }
            assistantContent += delta;
            renderBlocks.appendText(delta);
            hasStreamedText = true;
            hasTextSinceLastToolBoundary = true;
            yield {
              type: "text-delta",
              delta,
            };
          }
          continue;
        }

        if (mode === "updates") {
          rememberObservedToolCalls(
            observedToolCallsById,
            extractToolCallsFromUpdates(payload),
          );
          const assistantFromUpdates =
            resolveAssistantContentFromUpdatesChunk(payload);
          if (assistantFromUpdates && assistantFromUpdates.trim().length > 0) {
            assistantContentFromUpdates = assistantFromUpdates.trim();
          }
          const hitlInterrupts = extractHitlInterrupts(payload);
          if (hitlInterrupts.length > 0) {
            currentReasoningSegment = null;
            if (hasTextSinceLastToolBoundary) {
              yield {
                type: "text-interrupted",
                reason: "tool-call",
                toolCallId: "tool_confirmation",
                tool: "tool_confirmation",
              };
              assistantContent += "\n";
              renderBlocks.appendText("\n");
              yield {
                type: "text-delta",
                delta: "\n",
              };
              hasTextSinceLastToolBoundary = false;
            }

            const observedToolCalls = [...observedToolCallsById.values()];
            const usedToolCallIds = new Set<string>();
            const interruptCheckpoint = await resolvePendingInterruptCheckpoint(
              {
                agent,
                config: runConfig,
              },
            );
            const hitlCheckpoint = resolveHitlInterruptCheckpoint({
              pendingCheckpoint: interruptCheckpoint,
              observedCheckpoint: finalCheckpoint,
            });
            if (!hitlCheckpoint) {
              throw new ContentError(
                409,
                "AGENT_HITL_CHECKPOINT_MISSING",
                "DeepAgents HITL interrupt did not provide a resumable checkpoint.",
              );
            }
            connectorToolContext.actionApprovalScope =
              buildConnectorActionApprovalScope({
                threadId: hitlCheckpoint.threadId,
                checkpointId: hitlCheckpoint.checkpointId,
              });
            const autoApprovedHitlDecisions =
              buildAutoApprovedHitlResumeDecisions({
                connectorContext: connectorToolContext,
                hitlInterrupts,
              });
            if (
              autoApprovedHitlDecisions &&
              autoApprovedHitlResumeCount < maxAutoApprovedHitlResumes
            ) {
              autoApprovedHitlResumeCount += 1;
              finalCheckpoint = hitlCheckpoint;
              beforeAssistantCheckpoint = hitlCheckpoint;
              logger.info(
                "Agent HITL interrupt already has approved connector execution refs; resuming without a duplicate confirmation",
                {
                  workspaceId: input.prepared.workspace.id,
                  threadId: input.prepared.thread.id,
                  userId: input.prepared.userId,
                  decisionCount: autoApprovedHitlDecisions.length,
                  autoApprovedHitlResumeCount,
                },
              );
              stream = await agent.stream(
                new Command({
                  resume: commandResumeFromHitlDecisions({
                    decisions: autoApprovedHitlDecisions,
                    hitlInterruptId:
                      hitlInterrupts.length === 1
                        ? hitlInterrupts[0]?.id
                        : undefined,
                  }),
                }),
                runConfig as AgentRunnableConfig,
              );
              continue streamLoop;
            }
            for (const interruptRequest of hitlInterrupts) {
              for (const [
                index,
                action,
              ] of interruptRequest.actionRequests.entries()) {
                const observedToolCall = matchInterruptedToolCall({
                  action,
                  index,
                  observedToolCalls,
                  usedToolCallIds,
                });
                const reviewConfig =
                  interruptRequest.reviewConfigs.find(
                    (config) => config.actionName === action.name,
                  ) ?? interruptRequest.reviewConfigs[index];
                const confirmation = await createHitlConfirmation({
                  action,
                  connectorContext: connectorToolContext,
                  hitlInterruptId: interruptRequest.id,
                  reviewConfig,
                  toolCallId: observedToolCall.id,
                });
                const latencyMs = 0;
                const nextToolCall: ToolCallTrace = {
                  id: observedToolCall.id,
                  tool: action.name,
                  input: action.args,
                  output: confirmation,
                  status: "approval_requested",
                  latencyMs,
                  error: null,
                  sequence:
                    toolCallsById.get(observedToolCall.id)?.sequence ??
                    resolveToolCallSequence(observedToolCall.id),
                };
                if (!toolCallsById.has(observedToolCall.id)) {
                  toolCallOrder.push(observedToolCall.id);
                }
                toolCallsById.set(observedToolCall.id, nextToolCall);
                const runningToolCall: ToolCallTrace = {
                  ...nextToolCall,
                  output: null,
                  status: "running",
                };
                yield {
                  type: "tool-call-start",
                  id: observedToolCall.id,
                  tool: action.name,
                  input: action.args,
                  toolCall: runningToolCall,
                };
                yield {
                  type: "tool-call-result",
                  id: observedToolCall.id,
                  tool: action.name,
                  input: action.args,
                  output: confirmation,
                  latencyMs,
                  toolCall: nextToolCall,
                };
                yield {
                  type: "tool-call-end",
                  id: observedToolCall.id,
                  tool: action.name,
                  latencyMs,
                  status: "approval_requested",
                  toolCall: nextToolCall,
                };
                logger.info("Agent turn paused for DeepAgents HITL interrupt", {
                  workspaceId: input.prepared.workspace.id,
                  threadId: input.prepared.thread.id,
                  userId: input.prepared.userId,
                  toolName: action.name,
                  toolCallId: observedToolCall.id,
                  confirmationId: confirmation.id,
                });
              }
            }

            finalCheckpoint = hitlCheckpoint;
            beforeAssistantCheckpoint = hitlCheckpoint;
            const finalText = assistantContent.trim();
            yield {
              type: "done",
              outcome: {
                assistantContent: finalText,
                usage,
                finishReason: "tool_confirmation_requested",
                reasoning: modelReasoning,
                retrieval: latestToolRetrieval,
                citations: [],
                availableCitations: citationRegistry.list(),
                retrievalCalls: collectRetrievalCalls(),
                toolCalls: collectToolCalls(),
                thinkingSteps: listThinkingSteps({
                  stepsById: thinkingStepsById,
                  stepOrder: thinkingStepOrder,
                }),
                reasoningSegments,
                agentCheckpoint: {
                  beforeInput: beforeInputCheckpoint,
                  beforeAssistant: beforeAssistantCheckpoint,
                  resume: hitlCheckpoint,
                  final: finalCheckpoint,
                },
              },
            };
            return;
          }
          continue;
        }

        if (mode === "custom") {
          const progressEvent = normalizeGeneratedImageProgressEvent(payload);
          if (!progressEvent) {
            continue;
          }

          const currentToolCall = toolCallsById.get(progressEvent.toolCallId);
          if (!currentToolCall) {
            continue;
          }

          const nextToolCall: ToolCallTrace = {
            ...currentToolCall,
            tool: progressEvent.tool,
            output: progressEvent.data,
            status: "running",
            error: null,
          };
          toolCallsById.set(progressEvent.toolCallId, nextToolCall);
          yield {
            type: "tool-call-event",
            id: progressEvent.toolCallId,
            tool: progressEvent.tool,
            data: progressEvent.data,
            toolCall: nextToolCall,
          };
          continue;
        }

        if (mode !== "tools") {
          continue;
        }

        const toolPayload = toObjectRecord(payload);
        if (!toolPayload) {
          continue;
        }

        const event =
          typeof toolPayload.event === "string" ? toolPayload.event : "";
        const toolName =
          typeof toolPayload.name === "string" && toolPayload.name.length > 0
            ? toolPayload.name
            : "tool";
        const toolCallId = resolveToolCallId({
          toolCallId:
            typeof toolPayload.toolCallId === "string"
              ? toolPayload.toolCallId
              : undefined,
          toolName,
          fallbackIndex: toolCallOrder.length + 1,
        });

        if (!toolCallsById.has(toolCallId)) {
          toolCallOrder.push(toolCallId);
          toolCallsById.set(toolCallId, {
            id: toolCallId,
            tool: toolName,
            input: {},
            output: null,
            status: "running" as ToolCallStatus,
            latencyMs: null,
            error: null,
            sequence: resolveToolCallSequence(toolCallId),
          });
        }

        const currentToolCall = toolCallsById.get(toolCallId);
        if (!currentToolCall) {
          continue;
        }

        if (event === "on_tool_start") {
          currentReasoningSegment = null;
          const normalizedInput = extractToolPayloadInput(toolPayload);
          toolStartedAtById.set(toolCallId, Date.now());
          if (input.traceContext) {
            await startSpan({
              ...input.traceContext,
              spanId: toolCallId,
              parentSpanId: input.traceContext.parentSpanId,
              name: `tool:${toolName}`,
              kind: "tool",
              operation: "tool.call",
              input: normalizedInput,
              metadata: {
                toolName,
                sequence: currentToolCall.sequence,
              },
            });
          }
          const nextToolCall: ToolCallTrace = {
            ...currentToolCall,
            tool: toolName,
            input: normalizedInput,
            status: "running",
            error: null,
          };
          toolCallsById.set(toolCallId, nextToolCall);
          if (isGeneratedImageArtifactToolName(toolName)) {
            const progressEvent = normalizeGeneratedImageProgressEvent({
              type: GENERATED_IMAGE_PROGRESS_EVENT_TYPE,
              toolCallId,
              tool: toolName,
              stage: "preparing",
              ...(typeof normalizedInput.title === "string" &&
              normalizedInput.title.trim().length > 0
                ? { title: normalizedInput.title.trim() }
                : {}),
              ...(input.prepared.artifactIntent?.kind === "image"
                ? {
                    aspectRatio:
                      input.prepared.artifactIntent.config.aspectRatio,
                    quality: input.prepared.artifactIntent.config.quality,
                    style: input.prepared.artifactIntent.config.style,
                  }
                : {}),
            });
            if (progressEvent) {
              const progressToolCall: ToolCallTrace = {
                ...nextToolCall,
                output: progressEvent.data,
              };
              toolCallsById.set(toolCallId, progressToolCall);
              yield {
                type: "tool-call-event",
                id: toolCallId,
                tool: toolName,
                data: progressEvent.data,
                toolCall: progressToolCall,
              };
            }
          }
          if (hasTextSinceLastToolBoundary) {
            yield {
              type: "text-interrupted",
              reason: "tool-call",
              toolCallId,
              tool: toolName,
            };
            assistantContent += "\n";
            renderBlocks.appendText("\n");
            yield {
              type: "text-delta",
              delta: "\n",
            };
            hasTextSinceLastToolBoundary = false;
          }
          if (isGeneratedImageArtifactToolName(toolName)) {
            renderBlocks.appendGeneratedImage(toolCallId);
          }
          yield {
            type: "tool-call-start",
            id: toolCallId,
            tool: toolName,
            input: normalizedInput,
            toolCall: nextToolCall,
          };
          if (isRetrievalToolName(toolName)) {
            const query =
              typeof normalizedInput.query === "string"
                ? normalizedInput.query.trim()
                : "";
            yield {
              type: "thinking-step",
              step: setThinkingStep({
                id: `${toolName}:${toolCallId}`,
                kind: "state",
                title: "Searching sources",
                status: "in_progress",
                items: [],
                description:
                  query.length > 0
                    ? `Query: ${compactTraceText(query)}`
                    : undefined,
                metadata: {
                  toolCallId,
                  tool: toolName,
                },
              }),
            };
          } else if (isWebToolName(toolName)) {
            const title = getWebToolStartTitle(toolName);
            if (title) {
              const metadata = {
                ...getWebToolInputMetadata(toolName, normalizedInput),
                toolCallId,
                tool: toolName,
              };
              yield {
                type: "thinking-step",
                step: setThinkingStep({
                  id: `tool:${toolCallId}`,
                  kind: "state",
                  title,
                  status: "in_progress",
                  items: formatToolInputItems(normalizedInput),
                  metadata: {
                    ...metadata,
                  },
                }),
              };
            }
          } else if (isMcpToolName(toolName)) {
            yield {
              type: "thinking-step",
              step: setThinkingStep({
                id: `tool:${toolCallId}`,
                kind: "state",
                title: `Calling MCP ${getMcpToolDisplayName(toolName)}`,
                status: "in_progress",
                items: formatToolInputItems(normalizedInput),
                metadata: {
                  toolCallId,
                  tool: toolName,
                },
              }),
            };
          } else {
            const title = getFilesystemToolStartTitle(
              toolName,
              normalizedInput,
            );
            if (title) {
              yield {
                type: "thinking-step",
                step: setThinkingStep({
                  id: `tool:${toolCallId}`,
                  kind: "state",
                  title,
                  status: "in_progress",
                  items: formatToolInputItems(normalizedInput),
                  metadata: {
                    toolCallId,
                    tool: toolName,
                  },
                }),
              };
            }
          }
          continue;
        }

        if (event === "on_tool_event") {
          const toolData = toolPayload.data;
          const nextToolCall: ToolCallTrace = {
            ...currentToolCall,
            tool: toolName,
            output: toolData,
            status: "running",
            error: null,
          };
          toolCallsById.set(toolCallId, nextToolCall);
          yield {
            type: "tool-call-event",
            id: toolCallId,
            tool: toolName,
            data: toolData,
            toolCall: nextToolCall,
          };
          continue;
        }

        if (event === "on_tool_end") {
          currentReasoningSegment = null;
          nextReasoningContext = {
            phase: "after_tool",
            toolCallId,
            tool: toolName,
          };
          const retrievalCall = retrievalCallsById.get(toolCallId);
          const toolRetrieval = retrievalsByToolCallId.get(toolCallId) ?? null;
          const startedAt = toolStartedAtById.get(toolCallId);
          const normalizedInput = extractToolPayloadInput(toolPayload);
          const measuredLatency =
            typeof startedAt === "number" ? Date.now() - startedAt : null;
          const latencyMs = retrievalCall?.latencyMs ?? measuredLatency;
          const output = retrievalCall
            ? {
                query: retrievalCall.query,
                hitCount: retrievalCall.hitCount,
              }
            : normalizeToolOutputForObservability(toolName, toolPayload.output);
          const connectorContentError =
            getConnectorToolOutputContentError(output);
          const outputError =
            connectorContentError?.message ??
            getConnectorToolOutputError(output) ??
            (isWebToolName(toolName) ? getWebToolOutputError(output) : null);
          const toolStatus: ToolCallStatus = outputError
            ? "error"
            : "completed";
          const nextToolCall: ToolCallTrace = {
            ...currentToolCall,
            tool: toolName,
            input:
              Object.keys(currentToolCall.input).length > 0
                ? currentToolCall.input
                : normalizedInput,
            output,
            status: toolStatus,
            latencyMs,
            error: outputError,
          };
          toolCallsById.set(toolCallId, nextToolCall);
          if (input.traceContext) {
            await endSpan({
              traceId: input.traceContext.traceId,
              teamId: input.traceContext.teamId,
              workspaceId: input.traceContext.workspaceId,
              spanId: toolCallId,
              status: toolStatus === "error" ? "error" : "ok",
              latencyMs,
              output,
              ...(outputError ? { errorMessage: outputError } : {}),
              metadata: {
                toolName,
                ...(retrievalCall
                  ? {
                      query: retrievalCall.query,
                      hitCount: retrievalCall.hitCount,
                    }
                  : {}),
              },
            });
          }
          if (connectorContentError) {
            throw connectorContentError;
          }
          if (toolStatus === "completed") {
            yield {
              type: "tool-call-result",
              id: toolCallId,
              tool: toolName,
              input: nextToolCall.input,
              output,
              latencyMs,
              toolCall: nextToolCall,
              ...(retrievalCall
                ? {
                    query: retrievalCall.query,
                    hitCount: retrievalCall.hitCount,
                  }
                : {}),
            };
          }
          if (toolStatus === "error" && outputError) {
            yield {
              type: "tool-call-error",
              id: toolCallId,
              tool: toolName,
              input: nextToolCall.input,
              error: outputError,
              latencyMs,
              toolCall: nextToolCall,
            };
          }
          yield {
            type: "tool-call-end",
            id: toolCallId,
            tool: toolName,
            latencyMs,
            status: toolStatus,
            toolCall: nextToolCall,
          };
          if (isRetrievalToolName(toolName)) {
            const query = retrievalCall?.query ?? "";
            yield {
              type: "thinking-step",
              step: setThinkingStep({
                id: `${toolName}:${toolCallId}`,
                kind: "state",
                title: "Searching sources",
                status: "completed",
                items: [],
                description:
                  typeof retrievalCall?.hitCount === "number"
                    ? `Found ${retrievalCall.hitCount} relevant chunks.`
                    : undefined,
                metadata: {
                  query,
                  hitCount: retrievalCall?.hitCount,
                  latencyMs,
                  toolCallId,
                  tool: toolName,
                },
              }),
            };
          } else if (isWebToolName(toolName)) {
            const title = getWebToolEndTitle(toolName);
            if (title) {
              const metadata: Record<string, unknown> = {
                ...getWebToolInputMetadata(toolName, nextToolCall.input),
                ...getWebToolMetadata(toolPayload.output),
                latencyMs,
                toolCallId,
                tool: toolName,
              };
              yield {
                type: "thinking-step",
                step: setThinkingStep({
                  id: `tool:${toolCallId}`,
                  kind: "state",
                  title: toolStatus === "error" ? `${title} failed` : title,
                  status: "completed",
                  items: formatToolInputItems(nextToolCall.input),
                  description: outputError ?? undefined,
                  metadata,
                }),
              };
            }
          } else if (isMcpToolName(toolName)) {
            yield {
              type: "thinking-step",
              step: setThinkingStep({
                id: `tool:${toolCallId}`,
                kind: "state",
                title:
                  toolStatus === "error"
                    ? `MCP ${getMcpToolDisplayName(toolName)} failed`
                    : `Called MCP ${getMcpToolDisplayName(toolName)}`,
                status: "completed",
                items: formatToolInputItems(nextToolCall.input),
                description: outputError ?? undefined,
                metadata: {
                  latencyMs,
                  toolCallId,
                  tool: toolName,
                },
              }),
            };
          } else {
            const title = getFilesystemToolEndTitle(
              toolName,
              nextToolCall.input,
            );
            if (title) {
              const metadata = {
                ...getFilesystemToolMetadata(toolName, output),
                latencyMs,
                toolCallId,
                tool: toolName,
              };
              yield {
                type: "thinking-step",
                step: setThinkingStep({
                  id: `tool:${toolCallId}`,
                  kind: "state",
                  title,
                  status: "completed",
                  items: formatToolInputItems(nextToolCall.input),
                  description: getFilesystemToolDescription(
                    toolName,
                    metadata,
                    nextToolCall.input,
                  ),
                  metadata,
                }),
              };
            }
          }
          const citationSnapshot = getNewCitationSnapshot();
          if (citationSnapshot) {
            yield {
              type: "citations",
              citations: citationSnapshot,
            };
          }
          continue;
        }

        if (event === "on_tool_error") {
          currentReasoningSegment = null;
          nextReasoningContext = {
            phase: "after_tool",
            toolCallId,
            tool: toolName,
          };
          const startedAt = toolStartedAtById.get(toolCallId);
          const latencyMs =
            typeof startedAt === "number"
              ? Date.now() - startedAt
              : currentToolCall.latencyMs;
          const errorText = normalizeErrorText(toolPayload.error);
          const connectorContentError =
            getConnectorToolErrorTextContentError(errorText);
          const nextToolCall: ToolCallTrace = {
            ...currentToolCall,
            tool: toolName,
            status: "error",
            latencyMs,
            error: errorText,
          };
          toolCallsById.set(toolCallId, nextToolCall);
          if (input.traceContext) {
            await endSpan({
              traceId: input.traceContext.traceId,
              teamId: input.traceContext.teamId,
              workspaceId: input.traceContext.workspaceId,
              spanId: toolCallId,
              status: "error",
              latencyMs,
              errorMessage: errorText,
              metadata: {
                toolName,
              },
            });
          }
          if (connectorContentError) {
            throw connectorContentError;
          }
          yield {
            type: "tool-call-error",
            id: toolCallId,
            tool: toolName,
            input: nextToolCall.input,
            error: errorText,
            latencyMs,
            toolCall: nextToolCall,
          };
          yield {
            type: "tool-call-end",
            id: toolCallId,
            tool: toolName,
            latencyMs,
            status: "error",
            toolCall: nextToolCall,
          };
          const webTitle = getWebToolEndTitle(toolName);
          const title = getFilesystemToolEndTitle(toolName, nextToolCall.input);
          if (webTitle) {
            yield {
              type: "thinking-step",
              step: setThinkingStep({
                id: `tool:${toolCallId}`,
                kind: "state",
                title: `${webTitle} failed`,
                status: "completed",
                items: formatToolInputItems(nextToolCall.input),
                description: errorText,
                metadata: {
                  latencyMs,
                  toolCallId,
                  tool: toolName,
                },
              }),
            };
          } else if (title) {
            yield {
              type: "thinking-step",
              step: setThinkingStep({
                id: `tool:${toolCallId}`,
                kind: "state",
                title: `${title} failed`,
                status: "completed",
                items: formatToolInputItems(nextToolCall.input),
                description: errorText,
                metadata: {
                  latencyMs,
                  toolCallId,
                  tool: toolName,
                },
              }),
            };
          }
        }
      }
      if (
        retryAttempted ||
        input.prepared.agentMode === "replay" ||
        isCommandSuccessSatisfied({
          criteria: input.prepared.commandSuccessCriteria,
          toolCalls: collectToolCalls(),
        })
      ) {
        break;
      }

      const retryInstruction = buildCommandRetryInstruction(
        input.prepared.commandSuccessCriteria,
      );
      if (!retryInstruction) {
        break;
      }
      retryAttempted = true;
      yield {
        type: "thinking-step",
        step: setThinkingStep({
          id: "command-retry",
          kind: "verification",
          title: "Retrying command",
          status: "in_progress",
          items: [],
          description: retryInstruction,
          metadata: {
            criteria: input.prepared.commandSuccessCriteria,
          },
        }),
      };
      if (hasTextSinceLastToolBoundary) {
        assistantContent += "\n";
        renderBlocks.appendText("\n");
        yield {
          type: "text-delta",
          delta: "\n",
        };
        hasTextSinceLastToolBoundary = false;
      }
      stream = await runAgentStream([
        {
          role: "user" as const,
          content: retryInstruction,
        },
      ]);
    }
  } finally {
    await mcpToolRuntime?.close();
  }

  const streamedAssistantText = assistantContent.trim();
  const hasCompletedToolOutput = collectToolCalls().some(
    (call) => call.status === "completed" && !call.error,
  );
  let assistantText = resolveFinalAssistantText({
    assistantContent,
    assistantContentFromUpdates,
    hasCompletedToolOutput,
    allowSilentEmptyResponse: shouldSilenceEmptyApprovalResume({
      assistantMessageId: input.prepared.assistantMessageId,
      hasCompletedToolOutput,
      toolApprovalResume: input.prepared.toolApprovalResume,
    }),
  });

  const finalRetrieval = latestToolRetrieval;
  const finalCitations = citationRegistry.list();
  const reasoningSummary =
    extractReasoningSummaryFromProviderFields(providerFields);

  if (reasoningSummary) {
    yield {
      type: "thinking-step",
      step: setThinkingStep({
        id: "reasoning-summary",
        kind: "reasoning_summary",
        title: "Reasoning summary",
        status: "completed",
        items: [],
        description: compactTraceText(reasoningSummary, 280),
      }),
    };
  }

  yield {
    type: "thinking-step",
    step: setThinkingStep({
      id: "verify",
      kind: "verification",
      title: "Checking citations",
      status: "in_progress",
      items: [],
      description: "Normalizing citation markers before saving the answer.",
    }),
  };

  const citationNormalization = normalizeAssistantCitations({
    assistantText,
    citations: finalCitations,
  });
  assistantText = citationNormalization.text;
  const usedCitations = citationNormalization.citations;
  const availableCitationCount = finalCitations.length;
  const usedCitationCount = usedCitations.length;
  const removedCitationCount = citationNormalization.invalidKeys.length;
  const missingInlineCitationMarkers =
    availableCitationCount > 0 && citationNormalization.markerCount === 0;

  yield {
    type: "thinking-step",
    step: setThinkingStep({
      id: "verify",
      kind: "verification",
      title: "Checking citations",
      status: "completed",
      items: [],
      description: [
        `Used ${usedCitationCount} of ${availableCitationCount} available citations`,
        missingInlineCitationMarkers
          ? "no inline citation markers found"
          : null,
        citationNormalization.removedInvalidCitations
          ? `removed ${removedCitationCount} unsupported markers`
          : null,
      ]
        .filter((part): part is string => part !== null)
        .join(" · "),
      metadata: {
        availableCitationCount,
        usedCitationCount,
        citationMarkerCount: citationNormalization.markerCount,
        validCitationMarkerCount: citationNormalization.validMarkerCount,
        ...(missingInlineCitationMarkers
          ? { missingInlineCitationMarkers: true }
          : {}),
        ...(removedCitationCount > 0 ? { removedCitationCount } : {}),
      },
    }),
  };

  yield {
    type: "citations",
    citations: usedCitations,
    availableCitations: finalCitations,
  };

  if (!hasStreamedText && assistantText.length > 0) {
    renderBlocks.appendText(assistantText);
    yield {
      type: "text-delta",
      delta: sanitizeSseValue(assistantText),
    };
  }

  const retrievalCalls = collectRetrievalCalls();
  const toolCalls = collectToolCalls();
  let commandFailed = false;
  if (
    !isCommandSuccessSatisfied({
      criteria: input.prepared.commandSuccessCriteria,
      toolCalls,
    })
  ) {
    const criteria = input.prepared.commandSuccessCriteria;
    const errorText = commandSuccessFailureText(criteria, toolCalls);
    assistantText = errorText;
    commandFailed = true;
    finishReason = "command_success_criteria_failed";
    if (!hasStreamedText) {
      renderBlocks.appendText(errorText);
      yield {
        type: "text-delta",
        delta: sanitizeSseValue(errorText),
      };
    }
    yield {
      type: "thinking-step",
      step: setThinkingStep({
        id: "command-success",
        kind: "verification",
        title: "Checking command outcome",
        status: "completed",
        items: [],
        description: errorText,
        metadata: {
          criteria,
        },
      }),
    };
  }
  const finalState = finalCheckpoint
    ? null
    : await getAgentStateOrNull(agent, runConfig);
  finalCheckpoint ??= checkpointRefFromConfig(
    (finalState as { config?: unknown } | null)?.config,
  );
  const finalRenderBlocks: MessageRenderBlock[] = finalizeMessageRenderBlocks({
    blocks: commandFailed ? [] : renderBlocks.list(),
    finalText: assistantText,
  });

  yield {
    type: "done",
    outcome: {
      assistantContent: assistantText,
      usage,
      finishReason,
      reasoning: modelReasoning,
      retrieval: finalRetrieval,
      citations: usedCitations,
      availableCitations: finalCitations,
      retrievalCalls,
      toolCalls,
      ...(finalRenderBlocks.length > 0
        ? { renderBlocks: finalRenderBlocks }
        : {}),
      thinkingSteps: listThinkingSteps({
        stepsById: thinkingStepsById,
        stepOrder: thinkingStepOrder,
      }),
      reasoningSegments,
      agentCheckpoint: {
        beforeInput: beforeInputCheckpoint,
        beforeAssistant: beforeAssistantCheckpoint,
        resume: null,
        final: finalCheckpoint,
      },
    },
  };
}
