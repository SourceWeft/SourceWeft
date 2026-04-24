import { createHash, randomUUID } from "node:crypto";
import { ModelGatewayError, type ChatCompleteResult, type UsageInfo } from "@sourceweft/model-gateway";
import {
  createByokKeyRefRecord,
  createCitationRecords,
  createMessageRecord,
  createRetrievalHits,
  createRetrievalRun,
  createSourceRecord,
  createSourceRevisionRecord,
  createThreadRecord,
  deleteByokKeyRefRecord,
  deleteSourceRecord,
  findCitationByMessageRank,
  findSourceRecord,
  findThreadRecord,
  getSourceDetailRecord,
  getSourceStatusDetail,
  listByokKeyRefRecords,
  listSourceChunks,
  listSourceRecords,
  listThreadRecordsByWorkspace,
  listMessageRecordsByThread,
  replaceSourceDocumentsAndEmbeddings,
  updateThreadModelSettingsRecord,
  searchChunksByBm25,
  updateSourceRecord,
  updateSourceStatus,
} from "./store";
import { ContentError } from "./errors";
import { workspaceService } from "../workspace";
import { billingService } from "../billing";
import { createModelGatewayEvent } from "../../shared/model-gateway-observe";
import { vectorSearchProvider } from "./vector";
import {
  ensureModelConfigAvailable,
  getModelGatewayClient,
  requireDefaultModelGatewayProfile,
} from "../../shared/model-gateway";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../shared/database";
import {
  modelGatewayConfigVersions,
  modelGatewayConfigs,
  modelGatewayProviderConfigs,
  modelGatewayProfiles,
  modelGatewayRoutes,
} from "../../shared/db/schema";
import { config as sharedConfig } from "../../shared/config";
import { encryptSecret } from "../../shared/secrets";
import { getSourceParser, listSupportedSourceMimeTypes } from "./parsers";
import { buildSourceStorageKey, downloadSourceObject, uploadSourceObject } from "./storage";
import { enqueueSourceParseJob, type SourceParseJobPayload } from "./queue";
import { chunkSourceContent } from "./chunker";
import { buildAgentConfig, createThreadAgent } from "./agent";
import { createRetrievalTool } from "./agent/tools/retrieval-tool";
import {
  buildCitationMetadata,
  planRetrievalStrategy,
  reciprocalRankFusion,
  type RetrievalCandidate,
} from "./retrieval/planner";
import type { ModelPricing } from "../../shared/db/schema-types";
import type {
  ChunkSpec,
  MessageRecord,
  ParsingConfig,
  SourceRecord,
  SourceStatusDetail,
} from "./types";

const DEFAULT_MODEL_ALIAS = "chat-default";
const DEFAULT_RRF_K = 60;
const DEFAULT_VECTOR_TOP_K = 8;
const DEFAULT_BM25_TOP_K = 12;
const DEFAULT_PARSER_VERSION = "v1";
const DEFAULT_CHUNK_SIZE = 512;
const DEFAULT_THREAD_PAGE_LIMIT = 20;

type ThreadsCursor = {
  id: string;
  updatedAt: string;
};

function normalizeTitle(value: string | undefined, fallback: string) {
  const normalized = value?.trim();
  if (!normalized) {
    return fallback;
  }

  return normalized.slice(0, 200);
}

function estimateTokens(text: string) {
  return Math.max(1, Math.ceil(text.length / 4));
}

function defaultParsingConfig(overrides?: Partial<ParsingConfig>): ParsingConfig {
  return {
    chunkSize: overrides?.chunkSize ?? DEFAULT_CHUNK_SIZE,
    parserVersion: overrides?.parserVersion ?? DEFAULT_PARSER_VERSION,
  };
}

function computeContentHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function encodeThreadsCursor(input: ThreadsCursor) {
  return Buffer.from(JSON.stringify(input), "utf8").toString("base64url");
}

function decodeThreadsCursor(cursor: string): ThreadsCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Partial<ThreadsCursor>;

    if (
      !parsed ||
      typeof parsed.id !== "string" ||
      typeof parsed.updatedAt !== "string"
    ) {
      throw new Error("Invalid cursor shape");
    }

    const date = new Date(parsed.updatedAt);
    if (Number.isNaN(date.getTime())) {
      throw new Error("Invalid cursor timestamp");
    }

    return {
      id: parsed.id,
      updatedAt: date.toISOString(),
    };
  } catch {
    throw new ContentError(400, "INVALID_CURSOR", "Invalid threads cursor");
  }
}

function resolveUploadTitle(fileName: string) {
  const trimmed = fileName.trim();
  if (!trimmed) {
    return "Uploaded Source";
  }

  return normalizeTitle(trimmed.replace(/\.[^.]+$/, ""), "Uploaded Source");
}

function mergeStatusMetadata(
  source: SourceRecord,
  status: Partial<SourceStatusDetail> & Record<string, unknown>,
) {
  return {
    ...(source.metadata ?? {}),
    ...status,
  };
}

type LlmExecutionConfig = {
  modelAlias?: string;
  executionMode?: "GLOBAL" | "BYOK";
  providerHint?: string;
  byok?: {
    provider: string;
    apiKey?: string;
    apiKeyRef?: string;
  };
};

type ThreadModelKind = "llm" | "image" | "vision";
type ModelProfileKind = "chat" | "image" | "vision";

type ThreadModelSettings = {
  llmProfileAlias: string | null;
  imageProfileAlias: string | null;
  visionProfileAlias: string | null;
};

const MODEL_KIND_BY_THREAD_KIND: Record<ThreadModelKind, ModelProfileKind> = {
  llm: "chat",
  image: "image",
  vision: "vision",
};

const THREAD_KIND_BY_MODEL_KIND: Record<ModelProfileKind, ThreadModelKind> = {
  chat: "llm",
  image: "image",
  vision: "vision",
};

function normalizeThreadModelSettings(
  input:
    | Partial<ThreadModelSettings>
    | {
        llmProfileAlias?: string | null;
        imageProfileAlias?: string | null;
        visionProfileAlias?: string | null;
      }
    | undefined,
): ThreadModelSettings {
  const normalizeAlias = (value: string | null | undefined) => {
    const MAX_ALIAS_LENGTH = 512;
    if (typeof value !== "string") {
      return null;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return null;
    }
    return trimmed.length > MAX_ALIAS_LENGTH
      ? trimmed.slice(0, MAX_ALIAS_LENGTH)
      : trimmed;
  };

  return {
    llmProfileAlias: normalizeAlias(input?.llmProfileAlias),
    imageProfileAlias: normalizeAlias(input?.imageProfileAlias),
    visionProfileAlias: normalizeAlias(input?.visionProfileAlias),
  };
}

function mergeThreadModelSettings(
  current: ThreadModelSettings,
  patch: {
    llmProfileAlias?: string | null;
    imageProfileAlias?: string | null;
    visionProfileAlias?: string | null;
  },
): ThreadModelSettings {
  const next = { ...current };
  if (patch.llmProfileAlias !== undefined) {
    next.llmProfileAlias = normalizeThreadModelSettings({
      llmProfileAlias: patch.llmProfileAlias,
    }).llmProfileAlias;
  }
  if (patch.imageProfileAlias !== undefined) {
    next.imageProfileAlias = normalizeThreadModelSettings({
      imageProfileAlias: patch.imageProfileAlias,
    }).imageProfileAlias;
  }
  if (patch.visionProfileAlias !== undefined) {
    next.visionProfileAlias = normalizeThreadModelSettings({
      visionProfileAlias: patch.visionProfileAlias,
    }).visionProfileAlias;
  }
  return next;
}

async function computeProviderCost(input: {
  gatewayConfigId: string;
  modelAlias: string;
  userContent: string;
  assistantContent: string;
  usage?: UsageInfo;
}) {
  const [gatewayRow] = await db
    .select({ isBYOK: modelGatewayConfigs.isBYOK })
    .from(modelGatewayConfigs)
    .where(eq(modelGatewayConfigs.id, input.gatewayConfigId))
    .limit(1);

  if (gatewayRow?.isBYOK) {
    return 0;
  }

  const [profileRow] = await db
    .select({ configJson: modelGatewayProfiles.configJson })
    .from(modelGatewayProfiles)
    .where(
      and(
        eq(modelGatewayProfiles.modelAlias, input.modelAlias),
        eq(modelGatewayProfiles.isActive, true),
      ),
    )
    .limit(1);

  const pricing = profileRow?.configJson as ModelPricing | undefined;
  if (!pricing || pricing.price_source === "unknown") {
    return 0;
  }

  const usage = input.usage;
  const inputTokens = usage?.inputTokens ?? estimateTokens(input.userContent);
  const outputTokens =
    usage?.outputTokens ?? estimateTokens(input.assistantContent);
  const cacheReadTokens = usage?.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage?.cacheWriteTokens ?? 0;

  const providerCostUsd =
    inputTokens * (pricing.input_cost_per_token ?? 0) +
    outputTokens * (pricing.output_cost_per_token ?? 0) +
    cacheReadTokens * (pricing.cache_read_input_token_cost ?? 0) +
    cacheWriteTokens * (pricing.cache_creation_input_token_cost ?? 0);

  return Number(providerCostUsd.toFixed(6));
}

async function ensureProfileAliasExists(input: {
  profileKind: ModelProfileKind;
  modelAlias: string;
}) {
  const [row] = await db
    .select({ id: modelGatewayProfiles.id })
    .from(modelGatewayProfiles)
    .where(
      and(
        eq(modelGatewayProfiles.kind, input.profileKind),
        eq(modelGatewayProfiles.modelAlias, input.modelAlias),
        eq(modelGatewayProfiles.isActive, true),
      ),
    )
    .limit(1);

  if (!row) {
    throw new ContentError(
      400,
      "MODEL_ALIAS_INVALID",
      `Model alias '${input.modelAlias}' is not available for ${input.profileKind}`,
    );
  }
}

async function hasActiveProfileAlias(input: {
  profileKind: ModelProfileKind;
  modelAlias: string;
}) {
  const [row] = await db
    .select({ id: modelGatewayProfiles.id })
    .from(modelGatewayProfiles)
    .where(
      and(
        eq(modelGatewayProfiles.kind, input.profileKind),
        eq(modelGatewayProfiles.modelAlias, input.modelAlias),
        eq(modelGatewayProfiles.isActive, true),
      ),
    )
    .limit(1);

  return Boolean(row);
}

async function pruneUnavailableThreadModelAliases(
  settings: ThreadModelSettings,
  patch: {
    llmProfileAlias?: string | null;
    imageProfileAlias?: string | null;
    visionProfileAlias?: string | null;
  },
): Promise<ThreadModelSettings> {
  const next = { ...settings };

  if (patch.llmProfileAlias === undefined && next.llmProfileAlias) {
    const valid = await hasActiveProfileAlias({
      profileKind: "chat",
      modelAlias: next.llmProfileAlias,
    });
    if (!valid) {
      next.llmProfileAlias = null;
    }
  }

  if (patch.imageProfileAlias === undefined && next.imageProfileAlias) {
    const valid = await hasActiveProfileAlias({
      profileKind: "image",
      modelAlias: next.imageProfileAlias,
    });
    if (!valid) {
      next.imageProfileAlias = null;
    }
  }

  if (patch.visionProfileAlias === undefined && next.visionProfileAlias) {
    const valid = await hasActiveProfileAlias({
      profileKind: "vision",
      modelAlias: next.visionProfileAlias,
    });
    if (!valid) {
      next.visionProfileAlias = null;
    }
  }

  return next;
}

async function resolveThreadChatModelAlias(input: {
  threadModelSettings: ThreadModelSettings;
  requestedModelAlias?: string | null;
}) {
  const requestedAlias =
    typeof input.requestedModelAlias === "string"
      ? input.requestedModelAlias.trim()
      : "";

  if (requestedAlias.length > 0) {
    await ensureProfileAliasExists({
      profileKind: "chat",
      modelAlias: requestedAlias,
    });

    return {
      modelAlias: requestedAlias,
      persistedAlias: requestedAlias,
    };
  }

  const threadAlias = input.threadModelSettings.llmProfileAlias;
  if (threadAlias) {
    const [row] = await db
      .select({ id: modelGatewayProfiles.id })
      .from(modelGatewayProfiles)
      .where(
        and(
          eq(modelGatewayProfiles.kind, "chat"),
          eq(modelGatewayProfiles.modelAlias, threadAlias),
          eq(modelGatewayProfiles.isActive, true),
        ),
      )
      .limit(1);

    if (row) {
      return {
        modelAlias: threadAlias,
        persistedAlias: threadAlias,
      };
    }
  }

  const defaultChatProfile = await requireDefaultModelGatewayProfile("chat");
  const fallbackAlias = defaultChatProfile.modelAlias || DEFAULT_MODEL_ALIAS;

  return {
    modelAlias: fallbackAlias,
    persistedAlias: input.threadModelSettings.llmProfileAlias,
  };
}

async function resolveActiveChatProfileByAlias(modelAlias: string) {
  const [row] = await db
    .select({
      gatewayConfigId: modelGatewayProfiles.gatewayConfigId,
      modelAlias: modelGatewayProfiles.modelAlias,
    })
    .from(modelGatewayProfiles)
    .where(
      and(
        eq(modelGatewayProfiles.kind, "chat"),
        eq(modelGatewayProfiles.modelAlias, modelAlias),
        eq(modelGatewayProfiles.isActive, true),
      ),
    )
    .limit(1);

  if (!row) {
    throw new ContentError(
      400,
      "MODEL_ALIAS_INVALID",
      `Model alias '${modelAlias}' is not available for chat`,
    );
  }

  return row;
}

function toContentServiceError(error: unknown): ContentError {
  if (!ModelGatewayError.isInstance(error)) {
    return new ContentError(502, "MODEL_UPSTREAM_ERROR", "LLM request failed");
  }

  const gatewayError = error as ModelGatewayError;

  if (gatewayError.code === "BAD_REQUEST") {
    return new ContentError(400, "MODEL_REQUEST_INVALID", gatewayError.message);
  }

  if (gatewayError.code === "RATE_LIMIT") {
    return new ContentError(
      429,
      "MODEL_RATE_LIMITED",
      "LLM provider rate limit reached",
    );
  }

  if (gatewayError.code === "TIMEOUT") {
    return new ContentError(504, "MODEL_TIMEOUT", "LLM request timed out");
  }

  if (gatewayError.code === "AUTH") {
    return new ContentError(
      502,
      "MODEL_GATEWAY_AUTH_ERROR",
      "Model gateway authentication failed",
    );
  }

  return new ContentError(502, "MODEL_UPSTREAM_ERROR", gatewayError.message);
}

function resolveByokKeySource(input: LlmExecutionConfig | undefined) {
  if (!input || input.executionMode !== "BYOK") {
    return "global";
  }
  if (input.byok?.apiKeyRef) {
    return "apiKeyRef";
  }
  if (input.byok?.apiKey) {
    return "rawApiKey";
  }
  return "byok";
}

function buildGatewayAuditMetadata(input: {
  llm?: LlmExecutionConfig;
  provider?: string;
  providerModel?: string;
  routeDecision?: Record<string, unknown> | undefined;
}) {
  return {
    executionMode: input.llm?.executionMode ?? "GLOBAL",
    providerHint: input.llm?.providerHint ?? null,
    byokProvider: input.llm?.byok?.provider ?? null,
    keySource: resolveByokKeySource(input.llm),
    provider: input.provider ?? null,
    providerModel: input.providerModel ?? null,
    routeDecision: input.routeDecision ?? null,
  };
}

async function recordGatewayOperationEvent(input: {
  teamId: string;
  workspaceId: string;
  userId?: string | null;
  threadId?: string | null;
  messageId?: string | null;
  feature: string;
  operation: string;
  modelKind?: "chat" | "rerank" | "embedding" | "asr" | "tts" | "vision" | "video";
  modelAlias?: string | null;
  llm?: LlmExecutionConfig;
  provider?: string | null;
  providerModel?: string | null;
  routeDecision?: Record<string, unknown> | null;
  usage?: UsageInfo;
  providerCostUsd?: number | null;
  traceId?: string;
  success: boolean;
  errorCode?: string | null;
  errorMessage?: string | null;
  latencyMs?: number | null;
  attributes?: Record<string, unknown>;
}) {
  const gateway = buildGatewayAuditMetadata({
    llm: input.llm,
    provider: input.provider ?? undefined,
    providerModel: input.providerModel ?? undefined,
    routeDecision: input.routeDecision ?? undefined,
  });

  await createModelGatewayEvent({
    traceId: input.traceId,
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    threadId: input.threadId,
    messageId: input.messageId,
    feature: input.feature,
    operation: input.operation,
    executionMode:
      typeof gateway.executionMode === "string" ? gateway.executionMode : null,
    keySource: typeof gateway.keySource === "string" ? gateway.keySource : null,
    provider: typeof gateway.provider === "string" ? gateway.provider : null,
    providerModel:
      typeof gateway.providerModel === "string" ? gateway.providerModel : null,
    modelAlias: input.modelAlias ?? null,
    routeStrategy:
      gateway.routeDecision && typeof gateway.routeDecision === "object" &&
      typeof (gateway.routeDecision as Record<string, unknown>).strategy === "string"
        ? ((gateway.routeDecision as Record<string, unknown>).strategy as string)
        : null,
    success: input.success,
    errorCode: input.errorCode ?? null,
    errorMessage: input.errorMessage ?? null,
    latencyMs: input.latencyMs ?? null,
    usage: input.usage,
    providerCostUsd: input.providerCostUsd ?? null,
    attributes: {
      providerHint: gateway.providerHint,
      byokProvider: gateway.byokProvider,
      routeDecision: gateway.routeDecision,
      modelKind: input.modelKind ?? null,
      billable: input.modelKind === "chat",
      ...(input.attributes ?? {}),
    },
  });
}

function buildGatewayRequestMetadata(input: {
  teamId: string;
  workspaceId: string;
  userId?: string | null;
  threadId?: string | null;
  messageId?: string | null;
  feature: string;
  operation: string;
  modelKind?: "chat" | "rerank" | "embedding" | "asr" | "tts" | "vision" | "video";
  modelAlias?: string | null;
  llm?: LlmExecutionConfig;
}) {
  const audit = buildGatewayAuditMetadata({ llm: input.llm });
  const routeDecision =
    audit.routeDecision && typeof audit.routeDecision === "object"
      ? (audit.routeDecision as Record<string, unknown>)
      : undefined;

  return {
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    userId: input.userId ?? null,
    threadId: input.threadId ?? null,
    messageId: input.messageId ?? null,
    feature: input.feature,
    operation: input.operation,
    modelAlias: input.modelAlias ?? null,
    executionMode:
      typeof audit.executionMode === "string" ? audit.executionMode : null,
    keySource: typeof audit.keySource === "string" ? audit.keySource : null,
    routeStrategy:
      routeDecision && typeof routeDecision.strategy === "string"
        ? routeDecision.strategy
        : null,
  } satisfies Record<string, unknown>;
}

function resolveAssistantContent(input: {
  raw: ChatCompleteResult["raw"];
}) {
  const raw = input.raw;
  const content =
    raw && typeof raw === "object"
      ? (raw as { content?: unknown }).content
      : undefined;

  const text =
    typeof content === "string"
      ? content.trim()
      : Array.isArray(content)
        ? content
            .map((part) => {
              if (typeof part === "string") {
                return part;
              }
              if (!part || typeof part !== "object") {
                return "";
              }
              const record = part as Record<string, unknown>;
              if (typeof record.text === "string") {
                return record.text;
              }
              if (typeof record.content === "string") {
                return record.content;
              }
              return "";
            })
            .filter(Boolean)
            .join("\n")
            .trim()
        : "";
  if (text.length > 0) {
    return text;
  }

  const toolCalls =
    raw && typeof raw === "object"
      ? (raw as { tool_calls?: unknown }).tool_calls
      : undefined;

  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    return toolCalls
      .map((toolCall) => {
        if (!toolCall || typeof toolCall !== "object") {
          return "";
        }
        const record = toolCall as Record<string, unknown>;
        const name = typeof record.name === "string" ? record.name : "tool";
        const args =
          record.args && typeof record.args === "object"
            ? JSON.stringify(record.args)
            : "{}";
        return `${name}: ${args}`;
      })
      .filter(Boolean)
      .join("\n");
  }

  return "Model returned an empty response.";
}

function extractTextDeltas(content: unknown): string[] {
  if (typeof content === "string") {
    return content.length > 0 ? [content] : [];
  }

  if (Array.isArray(content)) {
    return content
      .flatMap((part) => extractTextDeltas(part))
      .filter((part) => part.length > 0);
  }

  if (!content || typeof content !== "object") {
    return [];
  }

  const record = content as Record<string, unknown>;
  if (typeof record.text === "string" && record.text.length > 0) {
    return [record.text];
  }

  if (typeof record.content === "string" && record.content.length > 0) {
    return [record.content];
  }

  if (record.content !== undefined) {
    return extractTextDeltas(record.content);
  }

  if (record.delta !== undefined) {
    return extractTextDeltas(record.delta);
  }

  return [];
}

function collapseSupersededMessages(items: MessageRecord[]) {
  const supersededIds = new Set(
    items
      .map((item) => item.parentMessageId)
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  );

  return items.filter((item) => !supersededIds.has(item.id));
}

function resolveSourceIdsFromMessage(message: MessageRecord): string[] {
  const sourceIds =
    message.metadata && typeof message.metadata === "object"
      ? (message.metadata as { sourceIds?: unknown }).sourceIds
      : undefined;

  if (!Array.isArray(sourceIds)) {
    return [];
  }

  return sourceIds.filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

function dedupeSourceIds(sourceIds: string[] | undefined) {
  return [...new Set(sourceIds ?? [])].filter((value) => value.length > 0);
}

function normalizeVersionComparisonText(value: string) {
  return value
    .normalize("NFKC")
    .replace(/\r\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveLatestThreadTurn(messages: MessageRecord[]) {
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      latestUserIndex = index;
      break;
    }
  }

  if (latestUserIndex < 0) {
    return {
      latestUserMessage: null,
      latestAssistantMessage: null,
    };
  }

  const latestUserMessage = messages[latestUserIndex] ?? null;
  const assistantMessages = messages
    .slice(latestUserIndex + 1)
    .filter((message) => message.role === "assistant");

  return {
    latestUserMessage,
    latestAssistantMessage:
      assistantMessages.length > 0
        ? assistantMessages[assistantMessages.length - 1] ?? null
        : null,
  };
}

function resolveAssistantForUserMessage(
  messages: MessageRecord[],
  userMessage: MessageRecord,
) {
  const assistantsFromMetadata = messages.filter((message) => {
    if (message.role !== "assistant") {
      return false;
    }

    if (!message.metadata || typeof message.metadata !== "object") {
      return false;
    }

    const metadataUserMessageId =
      (message.metadata as { userMessageId?: unknown }).userMessageId;
    return metadataUserMessageId === userMessage.id;
  });
  if (assistantsFromMetadata.length > 0) {
    return assistantsFromMetadata[assistantsFromMetadata.length - 1] ?? null;
  }

  const userIndex = messages.findIndex((message) => message.id === userMessage.id);
  if (userIndex < 0) {
    return null;
  }

  const nextUserIndex = messages.findIndex(
    (message, index) => index > userIndex && message.role === "user",
  );
  const candidates = messages
    .slice(userIndex + 1, nextUserIndex >= 0 ? nextUserIndex : undefined)
    .filter((message) => message.role === "assistant");

  return candidates[candidates.length - 1] ?? null;
}

function resolveUserForAssistantMessage(
  messages: MessageRecord[],
  assistantMessage: MessageRecord,
) {
  if (assistantMessage.metadata && typeof assistantMessage.metadata === "object") {
    const metadataUserMessageId =
      (assistantMessage.metadata as { userMessageId?: unknown }).userMessageId;
    if (typeof metadataUserMessageId === "string" && metadataUserMessageId.length > 0) {
      const userFromMetadata = messages.find(
        (message) =>
          message.id === metadataUserMessageId &&
          message.role === "user",
      );
      if (userFromMetadata) {
        return userFromMetadata;
      }
    }
  }

  const assistantIndex = messages.findIndex(
    (message) => message.id === assistantMessage.id,
  );
  if (assistantIndex < 0) {
    return null;
  }

  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (candidate?.role === "user") {
      return candidate;
    }
  }

  return null;
}

function ensureMessageIsInThread(
  message: MessageRecord | undefined,
  threadId: string,
  code: string,
) {
  if (!message) {
    return;
  }

  if (message.threadId !== threadId) {
    throw new ContentError(400, code, "Message does not belong to the thread");
  }
}

async function resolveImplicitRefreshInput(input: {
  teamId: string;
  workspaceId: string;
  threadId: string;
  messageContent: string;
  sourceIds: string[];
  existingUserMessage?: MessageRecord;
  userMessageParentId?: string | null;
  assistantMessageParentId?: string | null;
}) {
  if (
    input.existingUserMessage ||
    input.userMessageParentId ||
    input.assistantMessageParentId
  ) {
    return {
      sourceIds: input.sourceIds,
      existingUserMessage: input.existingUserMessage,
      assistantMessageParentId: input.assistantMessageParentId ?? null,
    };
  }

  const messages = collapseSupersededMessages(
    await listMessageRecordsByThread({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
    }),
  );

  const { latestUserMessage, latestAssistantMessage } =
    resolveLatestThreadTurn(messages);

  if (!latestUserMessage || !latestAssistantMessage) {
    return {
      sourceIds: input.sourceIds,
      existingUserMessage: undefined,
      assistantMessageParentId: null,
    };
  }

  if (
    normalizeVersionComparisonText(latestUserMessage.content) !==
    normalizeVersionComparisonText(input.messageContent)
  ) {
    return {
      sourceIds: input.sourceIds,
      existingUserMessage: undefined,
      assistantMessageParentId: null,
    };
  }

  return {
    sourceIds:
      input.sourceIds.length > 0
        ? input.sourceIds
        : resolveSourceIdsFromMessage(latestUserMessage),
    existingUserMessage: latestUserMessage,
    assistantMessageParentId: latestAssistantMessage.id,
  };
}

function cosineSimilarity(left: number[], right: number[]) {
  const size = Math.min(left.length, right.length);
  if (size === 0) {
    return 0;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < size; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

// retrieval planner helpers moved to ./retrieval/planner

async function requireWorkspace(input: {
  workspaceId: string;
  userId: string;
}) {
  const workspace = await workspaceService.resolveWorkspace(input);
  if (!workspace) {
    throw new ContentError(404, "WORKSPACE_NOT_FOUND", "Workspace not found");
  }

  return workspace;
}

async function requireSource(input: {
  workspaceId: string;
  userId: string;
  sourceId: string;
}) {
  const workspace = await requireWorkspace({
    workspaceId: input.workspaceId,
    userId: input.userId,
  });

  const source = await findSourceRecord({
    sourceId: input.sourceId,
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
  });

  if (!source) {
    throw new ContentError(404, "SOURCE_NOT_FOUND", "Source not found");
  }

  return {
    workspace,
    source,
  };
}

async function assertSourcesExist(input: {
  teamId: string;
  workspaceId: string;
  sourceIds: string[];
}) {
  for (const sourceId of input.sourceIds) {
    const source = await findSourceRecord({
      sourceId,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
    });
    if (!source) {
      throw new ContentError(
        404,
        "SOURCE_NOT_FOUND",
        `Source '${sourceId}' not found in workspace`,
      );
    }
  }
}

async function requireDefaultEmbeddingProfile() {
  try {
    const profile = await requireDefaultModelGatewayProfile("embedding");
    return {
      ...profile,
      kind: "embedding" as const,
    };
  } catch {
    throw new ContentError(
      500,
      "EMBEDDING_PROFILE_NOT_CONFIGURED",
      "Default embedding profile is not configured",
    );
  }
}

// citation metadata helper moved to ./retrieval/planner


function sanitizeSseValue(value: string) {
  return value.replace(/\u0000/g, "");
}

function stringifyAgentMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .flatMap((part) => extractTextDeltas(part))
      .join("\n")
      .trim();
  }

  if (content && typeof content === "object") {
    const record = content as Record<string, unknown>;
    if (typeof record.text === "string") {
      return record.text;
    }
    if (typeof record.content === "string") {
      return record.content;
    }
  }

  return "";
}

function resolveAgentThreadId(input: {
  threadId: string;
  userMessageParentId?: string | null;
  assistantMessageParentId?: string | null;
}) {
  if (input.assistantMessageParentId) {
    return `${input.threadId}:assistant:${input.assistantMessageParentId}`;
  }
  if (input.userMessageParentId) {
    return `${input.threadId}:user:${input.userMessageParentId}`;
  }
  return input.threadId;
}

async function runToolRetrieval(input: {
  prepared: PreparedThreadTurn;
  query: string;
  llm?: LlmExecutionConfig;
}) {
  const retrieval = await runRetrieval({
    workspaceId: input.prepared.workspace.id,
    teamId: input.prepared.workspace.organizationId,
    threadId: input.prepared.thread.id,
    userId: input.prepared.userId,
    userMessageId: input.prepared.userMessage.id,
    queryText: input.query,
    sourceIds: input.prepared.sourceIds,
    idempotencyKey: input.prepared.llmIdempotencyKey,
    llm: input.llm,
  });

  return retrieval;
}

function toObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function resolveToolCallId(input: {
  toolCallId?: string;
  toolName: string;
  fallbackIndex: number;
}) {
  if (typeof input.toolCallId === "string" && input.toolCallId.length > 0) {
    return input.toolCallId;
  }
  return `${input.toolName}-${input.fallbackIndex}`;
}

function extractTextDeltasFromMessageChunk(chunk: unknown): string[] {
  const record = toObjectRecord(chunk);
  if (!record) {
    return extractTextDeltas(chunk);
  }

  const contentBlocks = Array.isArray(record.contentBlocks)
    ? record.contentBlocks
    : Array.isArray(record.content_blocks)
      ? (record.content_blocks as unknown[])
      : null;

  if (contentBlocks) {
    return contentBlocks
      .flatMap((block) => {
        if (!block || typeof block !== "object") {
          return [] as string[];
        }
        const part = block as Record<string, unknown>;
        if (typeof part.type === "string" && part.type !== "text") {
          return [] as string[];
        }
        return extractTextDeltas(part);
      })
      .filter((value) => value.length > 0);
  }

  return extractTextDeltas(record.content ?? chunk);
}

function resolveAssistantContentFromUpdatesChunk(chunk: unknown): string | null {
  const updates = toObjectRecord(chunk);
  if (!updates) {
    return null;
  }

  for (const nodeUpdate of Object.values(updates)) {
    const nodeRecord = toObjectRecord(nodeUpdate);
    if (!nodeRecord || !Array.isArray(nodeRecord.messages)) {
      continue;
    }

    const messages = nodeRecord.messages as Array<Record<string, unknown>>;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!message) {
        continue;
      }
      const role = typeof message.role === "string" ? message.role : "";
      const type =
        typeof message.type === "string"
          ? message.type
          : typeof message._getType === "function"
            ? String(message._getType())
            : typeof message.getType === "function"
              ? String(message.getType())
              : "";
      const isAssistant =
        role === "assistant" || role === "ai" || type === "assistant" || type === "ai";
      if (!isAssistant) {
        continue;
      }
      const content = stringifyAgentMessageContent(message.content);
      if (content.trim().length > 0) {
        return content.trim();
      }
    }
  }

  return null;
}

function normalizeToolInput(value: unknown): Record<string, unknown> {
  const record = toObjectRecord(value);
  return record ?? {};
}

function normalizeErrorText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Error) {
    return value.message;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.length > 0) {
      return record.message;
    }
    try {
      return JSON.stringify(record);
    } catch {
      return "Tool execution failed.";
    }
  }
  return "Tool execution failed.";
}

function toSseData(payload: Record<string, unknown>) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

type StreamThreadEventInput = {
  workspaceId: string;
  threadId: string;
  userId: string;
  content: string;
  sourceIds?: string[];
  idempotencyKey?: string;
  llm?: LlmExecutionConfig;
  userMessageParentId?: string | null;
  assistantMessageParentId?: string | null;
  existingUserMessage?: MessageRecord;
};

type PreparedThreadTurn = {
  userId: string;
  workspace: Awaited<ReturnType<typeof requireWorkspace>>;
  thread: NonNullable<Awaited<ReturnType<typeof findThreadRecord>>>;
  messageContent: string;
  sourceIds: string[];
  userMessage: MessageRecord;
  assistantMessageParentId: string | null;
  modelAlias: string;
  chatProfile: Awaited<ReturnType<typeof resolveActiveChatProfileByAlias>>;
  llmIdempotencyKey: string;
  deepAgentThreadId: string;
};

type RetrievalCallTrace = {
  id: string;
  tool: "retrieve";
  query: string;
  hitCount: number;
  latencyMs: number;
};

type ToolCallStatus = "running" | "completed" | "error";

type ToolCallTrace = {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  output: unknown;
  status: ToolCallStatus;
  latencyMs: number | null;
  error: string | null;
};

type DeepAgentTurnOutcome = {
  assistantContent: string;
  retrieval: Awaited<ReturnType<typeof runRetrieval>>;
  retrievalCalls: RetrievalCallTrace[];
  toolCalls: ToolCallTrace[];
};

type DeepAgentTurnEvent =
  | {
      type: "text-delta";
      delta: string;
    }
  | {
      type: "tool-call-start";
      id: string;
      tool: string;
      input: Record<string, unknown>;
      toolCall: ToolCallTrace;
    }
  | {
      type: "tool-call-event";
      id: string;
      tool: string;
      data: unknown;
      toolCall: ToolCallTrace;
    }
  | {
      type: "tool-call-result";
      id: string;
      tool: string;
      input: Record<string, unknown>;
      output: unknown;
      latencyMs: number | null;
      toolCall: ToolCallTrace;
      query?: string;
      hitCount?: number;
    }
  | {
      type: "tool-call-error";
      id: string;
      tool: string;
      input: Record<string, unknown>;
      error: string;
      latencyMs: number | null;
      toolCall: ToolCallTrace;
    }
  | {
      type: "tool-call-end";
      id: string;
      tool: string;
      latencyMs: number | null;
      status: "completed" | "error";
      toolCall: ToolCallTrace;
    }
  | {
      type: "done";
      outcome: DeepAgentTurnOutcome;
    };

function summarizeRetrievalCalls(retrievalCalls: RetrievalCallTrace[]) {
  const totalHitCount = retrievalCalls.reduce((sum, call) => sum + call.hitCount, 0);
  const totalLatencyMs = retrievalCalls.reduce((sum, call) => sum + call.latencyMs, 0);
  const maxLatencyMs = retrievalCalls.reduce(
    (max, call) => (call.latencyMs > max ? call.latencyMs : max),
    0,
  );

  return {
    count: retrievalCalls.length,
    totalHitCount,
    totalLatencyMs,
    avgLatencyMs:
      retrievalCalls.length > 0
        ? Math.round(totalLatencyMs / retrievalCalls.length)
        : null,
    maxLatencyMs: retrievalCalls.length > 0 ? maxLatencyMs : null,
  };
}

async function rerankCandidates(input: {
  queryText: string;
  candidates: RetrievalCandidate[];
  teamId: string;
  workspaceId: string;
  threadId: string;
  userId: string;
  llm?: LlmExecutionConfig;
}) {
  if (input.candidates.length <= 1) {
    return {
      candidates: input.candidates,
      modelAlias: null,
      gateway: buildGatewayAuditMetadata({ llm: input.llm }),
    };
  }

  const rerankProfile = await requireDefaultModelGatewayProfile("rerank");
  const gateway = await getModelGatewayClient(rerankProfile.gatewayConfigId);
  const rerankStartedAt = Date.now();
  const rerankResult = await gateway.rerank
    .rank({
      model: rerankProfile.modelAlias,
      query: input.queryText,
      documents: input.candidates.map((candidate) => candidate.content),
      topN: Math.min(input.candidates.length, 6),
      returnDocuments: false,
      metadata: {
        team_id: input.teamId,
        workspace_id: input.workspaceId,
        user_id: input.userId,
        thread_id: input.threadId,
        feature: "retrieval_rerank",
      },
      executionMode: input.llm?.executionMode,
      providerHint: input.llm?.providerHint,
      byok: input.llm?.byok,
    },
    {
      metadata: buildGatewayRequestMetadata({
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        userId: input.userId,
        threadId: input.threadId,
        feature: "retrieval_rerank",
        operation: "rerank.rank",
        modelKind: "rerank",
        modelAlias: rerankProfile.modelAlias,
        llm: input.llm,
      }),
    })
    .catch(async (error: unknown) => {
      const contentError = toContentServiceError(error);
      await recordGatewayOperationEvent({
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        userId: input.userId,
        threadId: input.threadId,
        messageId: null,
        feature: "retrieval_rerank",
        operation: "rerank.rank",
        modelKind: "rerank",
        modelAlias: rerankProfile.modelAlias,
        llm: input.llm,
        success: false,
        errorCode: contentError.code,
        errorMessage: contentError.message,
      });
      throw contentError;
    });

  return {
    modelAlias: rerankProfile.modelAlias,
    candidates: rerankResult.results
      .map((item) => {
        const candidate = input.candidates[item.index];
        if (!candidate) {
          return null;
        }
        return {
          ...candidate,
          score: item.relevanceScore,
        };
      })
      .filter((candidate): candidate is RetrievalCandidate => candidate !== null),
  };
}

async function runRetrieval(input: {
  workspaceId: string;
  teamId: string;
  threadId: string;
  userId: string;
  userMessageId: string;
  queryText: string;
  sourceIds: string[];
  idempotencyKey?: string;
  llm?: LlmExecutionConfig;
}) {
  await ensureModelConfigAvailable();
  const profile = await requireDefaultEmbeddingProfile();
  const embeddingGateway = await getModelGatewayClient(profile.gatewayConfigId);
  const planner = planRetrievalStrategy(profile);
  const sourceIds = [...new Set(input.sourceIds)];

  if (sourceIds.length === 0) {
    const retrievalRunId = await createRetrievalRun({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      messageId: input.userMessageId,
      embeddingProfileId: profile.id,
      queryText: input.queryText,
      embedModelAlias: profile.modelAlias,
      rerankModelAlias: null,
      vectorStrategyUsed: planner.strategy,
      annIndexUsed: planner.annIndexUsed,
      bm25TopK: DEFAULT_BM25_TOP_K,
      vectorTopK: DEFAULT_VECTOR_TOP_K,
      rrfK: DEFAULT_RRF_K,
      prefilterCount: 0,
      candidateCount: 0,
      finalResultCount: 0,
      latencyMs: 0,
      metadataJson: {
        requestedSourceIds: sourceIds,
        gateway: {
          embedding: null,
          rerank: buildGatewayAuditMetadata({ llm: input.llm }),
        },
      },
    });

    await createRetrievalHits({
      runId: retrievalRunId,
      hits: [],
    });

    return {
      profile,
      planner,
      fusedCandidates: [],
      retrievalSummary: [] as ReturnType<typeof buildCitationMetadata>,
    };
  }

  const startedAt = Date.now();
  let queryEmbedding: number[] = [];
  let embeddingAuditMetadata: Record<string, unknown> | null = null;
  if (planner.strategy !== "bm25_only") {
    const embedStartedAt = Date.now();
    const embedResult = await embeddingGateway.embeddings
      .embed(
        {
          model: profile.modelAlias,
          text: input.queryText,
          dimensions: planner.requestedDimensions ?? undefined,
          metadata: {
            team_id: input.teamId,
            workspace_id: input.workspaceId,
            user_id: input.userId,
            thread_id: input.threadId,
            feature: "retrieval",
          },
          executionMode: input.llm?.executionMode,
          providerHint: input.llm?.providerHint,
          byok: input.llm?.byok,
        },
        {
          idempotencyKey:
            input.idempotencyKey ||
            `thread-stream:${input.userMessageId}:query-embed`,
          traceId: input.userMessageId,
          metadata: buildGatewayRequestMetadata({
            teamId: input.teamId,
            workspaceId: input.workspaceId,
            userId: input.userId,
            threadId: input.threadId,
            messageId: input.userMessageId,
            feature: "retrieval",
            operation: "embeddings.embed",
            modelAlias: profile.modelAlias,
            llm: input.llm,
          }),
        },
      )
      .catch((error: unknown) => {
        throw toContentServiceError(error);
      });
    queryEmbedding = embedResult.embedding;
    embeddingAuditMetadata = buildGatewayAuditMetadata({
      llm: input.llm,
      provider: embedResult.provider,
      providerModel: embedResult.providerModel,
      routeDecision: embedResult.routeDecision as Record<string, unknown> | undefined,
    });
    await recordGatewayOperationEvent({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      threadId: input.threadId,
      messageId: input.userMessageId,
      feature: "retrieval",
      operation: "embeddings.embed",
      modelKind: "embedding",
      modelAlias: profile.modelAlias,
      llm: input.llm,
      provider: embedResult.provider,
      providerModel: embedResult.providerModel,
      routeDecision: embedResult.routeDecision as Record<string, unknown> | undefined,
      usage: embedResult.usage,
      traceId: input.userMessageId,
      success: true,
      latencyMs: Date.now() - embedStartedAt,
    });
  }

  const lexicalCandidates = await searchChunksByBm25({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    queryText: input.queryText,
    topK: DEFAULT_BM25_TOP_K,
    sourceIds,
  });

  let vectorCandidates: RetrievalCandidate[] = [];
  if (planner.strategy === "ann_hnsw" && planner.requestedDimensions) {
    vectorCandidates = await vectorSearchProvider.searchAnn({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      embeddingProfileId: profile.id,
      queryEmbedding,
      dim: planner.requestedDimensions,
      topK: DEFAULT_VECTOR_TOP_K,
      sourceIds,
    });
  } else if (planner.strategy !== "bm25_only") {
    vectorCandidates = await vectorSearchProvider.searchExact({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      embeddingProfileId: profile.id,
      queryEmbedding,
      topK: DEFAULT_VECTOR_TOP_K,
      sourceIds,
    });
  }

  const fusedCandidates = reciprocalRankFusion({
    vectorCandidates,
    bm25Candidates: lexicalCandidates,
    limit: 8,
    rrfK: DEFAULT_RRF_K,
  });
  const rerank = await rerankCandidates({
    queryText: input.queryText,
    candidates: fusedCandidates,
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    userId: input.userId,
    llm: input.llm,
  });
  const rerankedCandidates = rerank.candidates;
  const finalCandidates =
    rerankedCandidates.length > 0 ? rerankedCandidates : fusedCandidates;

  const retrievalRunId = await createRetrievalRun({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    messageId: input.userMessageId,
    embeddingProfileId: profile.id,
    queryText: input.queryText,
    embedModelAlias: profile.modelAlias,
    rerankModelAlias: rerank.modelAlias,
    vectorStrategyUsed: planner.strategy,
    annIndexUsed: planner.annIndexUsed,
    bm25TopK: DEFAULT_BM25_TOP_K,
    vectorTopK: DEFAULT_VECTOR_TOP_K,
    rrfK: DEFAULT_RRF_K,
    prefilterCount: null,
    candidateCount: Math.max(lexicalCandidates.length, vectorCandidates.length),
    finalResultCount: finalCandidates.length,
    latencyMs: Date.now() - startedAt,
    metadataJson: {
      requestedSourceIds: sourceIds,
      gateway: {
        embedding: embeddingAuditMetadata,
        rerank: rerank.gateway,
      },
    },
  });

  await createRetrievalHits({
    runId: retrievalRunId,
    hits: [
      ...vectorCandidates.map(
        (candidate: RetrievalCandidate, index: number) => ({
          sourceStage: "vector" as const,
          hitType: "chunk" as const,
          sourceId: candidate.sourceId,
          documentId: candidate.documentId,
          chunkId: candidate.chunkId,
          rank: index + 1,
          score: candidate.score,
        }),
      ),
      ...lexicalCandidates.map(
        (candidate: RetrievalCandidate, index: number) => ({
          sourceStage: "bm25" as const,
          hitType: "chunk" as const,
          sourceId: candidate.sourceId,
          documentId: candidate.documentId,
          chunkId: candidate.chunkId,
          rank: index + 1,
          score: candidate.score,
        }),
      ),
      ...fusedCandidates.map(
        (candidate: RetrievalCandidate, index: number) => ({
          sourceStage: "rrf" as const,
          hitType: "chunk" as const,
          sourceId: candidate.sourceId,
          documentId: candidate.documentId,
          chunkId: candidate.chunkId,
          rank: index + 1,
          score: candidate.score,
        }),
      ),
      ...finalCandidates.map(
        (candidate: RetrievalCandidate, index: number) => ({
          sourceStage: "rerank" as const,
          hitType: "chunk" as const,
          sourceId: candidate.sourceId,
          documentId: candidate.documentId,
          chunkId: candidate.chunkId,
          rank: index + 1,
          score: candidate.score,
        }),
      ),
    ],
  });

  return {
    profile,
    planner,
    fusedCandidates: finalCandidates,
    retrievalSummary: buildCitationMetadata(finalCandidates),
  };
}

export class ContentService {
  async uploadSource(input: {
    workspaceId: string;
    userId: string;
    fileName: string;
    mimeType: string;
    content: Buffer;
    sizeBytes: number;
  }) {
    const workspace = await requireWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });

    const parser = getSourceParser(input.mimeType);
    if (!parser) {
      throw new ContentError(
        400,
        "UNSUPPORTED_SOURCE_TYPE",
        `Unsupported MIME type: ${input.mimeType}`,
      );
    }

    const parsingConfig = defaultParsingConfig();
    const source = await createSourceRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      title: resolveUploadTitle(input.fileName),
      contentText: "",
      createdBy: input.userId,
      sourceType: "file_upload",
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      parserVersion: parsingConfig.parserVersion,
      parsingConfig,
      metadata: {
        fileName: input.fileName,
        fileSize: input.sizeBytes,
        mimeType: input.mimeType,
        uploadMethod: "api",
        progress: 0,
        currentStep: "uploading",
      },
    });

    const storageKey = buildSourceStorageKey({
      workspaceId: workspace.id,
      sourceId: source.id,
      fileName: input.fileName,
    });

    await uploadSourceObject({
      key: storageKey,
      body: input.content,
      contentType: input.mimeType,
    });

    const updatedSource = await updateSourceRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      sourceId: source.id,
      storageBucket: sharedConfig.s3.bucket,
      storageKey,
      status: "queued",
      metadata: mergeStatusMetadata(source, {
        fileName: input.fileName,
        fileSize: input.sizeBytes,
        mimeType: input.mimeType,
        progress: 5,
        currentStep: "queued",
      }),
    });

    if (!updatedSource) {
      throw new ContentError(500, "SOURCE_UPLOAD_FAILED", "Failed to queue uploaded source");
    }

    const revision = await createSourceRevisionRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      sourceId: updatedSource.id,
      storageBucket: sharedConfig.s3.bucket,
      storageKey,
      parserVersion: parsingConfig.parserVersion,
    });

    const job = await enqueueSourceParseJob({
      sourceId: updatedSource.id,
      workspaceId: workspace.id,
      teamId: workspace.organizationId,
      userId: input.userId,
      idempotencyKey: `source-parse:${updatedSource.id}:${revision.revisionNo}`,
    });

    const queuedSource = await updateSourceRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      sourceId: updatedSource.id,
      metadata: mergeStatusMetadata(updatedSource, {
        progress: 10,
        currentStep: "queued",
        jobId: String(job.id),
      }),
    });

    const status = await getSourceStatusDetail({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      sourceId: updatedSource.id,
    });

    return {
      source: queuedSource ?? updatedSource,
      status: status ?? {
        status: "queued",
        progress: 10,
        currentStep: "queued",
        parsedPages: null,
        totalPages: null,
        error: null,
        jobId: String(job.id),
      },
    };
  }

  async createSource(input: {
    workspaceId: string;
    userId: string;
    title?: string;
    contentText?: string;
    estimatedPages?: number;
    parsedTokens?: number;
  }) {
    const workspace = await requireWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });

    const source = await createSourceRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      title: normalizeTitle(input.title, "Untitled Source"),
      contentText: input.contentText ?? "",
      createdBy: input.userId,
      estimatedPages: input.estimatedPages,
      parsedTokens: input.parsedTokens,
    });

    return { source };
  }

  async listSources(input: { workspaceId: string; userId: string }) {
    const workspace = await requireWorkspace(input);
    const items = await listSourceRecords({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
    });

    return { items };
  }

  async getSource(input: {
    workspaceId: string;
    sourceId: string;
    userId: string;
  }) {
    const { workspace, source } = await requireSource(input);
    const detail = await getSourceDetailRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      sourceId: source.id,
    });

    if (!detail) {
      throw new ContentError(404, "SOURCE_NOT_FOUND", "Source not found");
    }

    return detail;
  }

  async getSourceStatus(input: {
    workspaceId: string;
    sourceId: string;
    userId: string;
  }) {
    const { workspace, source } = await requireSource(input);
    const detail = await getSourceStatusDetail({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      sourceId: source.id,
    });

    if (!detail) {
      throw new ContentError(404, "SOURCE_NOT_FOUND", "Source not found");
    }

    return detail;
  }

  async getSourceContent(input: {
    workspaceId: string;
    sourceId: string;
    userId: string;
  }) {
    const { source } = await requireSource(input);
    return {
      source,
      content: source.contentText,
    };
  }

  async updateSource(input: {
    workspaceId: string;
    sourceId: string;
    userId: string;
    title?: string;
    contentText?: string;
    estimatedPages?: number | null;
    parsedTokens?: number | null;
  }) {
    const { workspace, source } = await requireSource(input);

    const updated = await updateSourceRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      sourceId: source.id,
      title:
        input.title !== undefined
          ? normalizeTitle(input.title, source.title)
          : undefined,
      contentText: input.contentText,
      estimatedPages: input.estimatedPages,
      parsedTokens: input.parsedTokens,
    });

    if (!updated) {
      throw new ContentError(404, "SOURCE_NOT_FOUND", "Source not found");
    }

    return { source: updated };
  }

  async deleteSource(input: {
    workspaceId: string;
    sourceId: string;
    userId: string;
  }) {
    const { workspace, source } = await requireSource(input);
    const deleted = await deleteSourceRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      sourceId: source.id,
    });

    if (!deleted) {
      throw new ContentError(404, "SOURCE_NOT_FOUND", "Source not found");
    }

    return {
      deleted: true as const,
      sourceId: source.id,
    };
  }

  async indexSource(input: {
    workspaceId: string;
    sourceId: string;
    userId: string;
    estimatedPages?: number;
    parsedTokens?: number;
    idempotencyKey?: string;
    chunks?: ChunkSpec[];
  }) {
    const { workspace, source } = await requireSource(input);

    await ensureModelConfigAvailable();
    const profile = await requireDefaultEmbeddingProfile();
    const embeddingGateway = await getModelGatewayClient(profile.gatewayConfigId);
    const planner = planRetrievalStrategy(profile);
    const existingChunks = input.chunks
      ? null
      : await listSourceChunks({
          teamId: workspace.organizationId,
          workspaceId: workspace.id,
          sourceId: source.id,
        });
    const chunkSpecs =
      input.chunks ??
      (existingChunks && existingChunks.length > 0
        ? existingChunks.map((chunk) => ({
            text: chunk.content,
            startIndex: chunk.startOffset ?? 0,
            endIndex: chunk.endOffset ?? chunk.content.length,
            tokenCount:
              typeof chunk.chunkMetadata.tokenCount === "number"
                ? chunk.chunkMetadata.tokenCount
                : Math.max(1, Math.ceil(chunk.content.length / 4)),
          }))
        : await chunkSourceContent(source.contentText, source.parsingConfig));

    await updateSourceStatus({
      sourceId: source.id,
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      status: "processing",
      estimatedPages: input.estimatedPages ?? source.estimatedPages,
      parsedTokens: input.parsedTokens ?? source.parsedTokens,
    });

    let embeddings: number[][] = [];
    try {
      if (chunkSpecs.length > 0 && profile.vectorStrategy !== "disabled") {
        const result = await embeddingGateway.embeddings
          .embedBatch(
            {
              model: profile.modelAlias,
              texts: chunkSpecs.map((chunk) => chunk.text),
              dimensions: planner.requestedDimensions ?? undefined,
              metadata: {
                team_id: workspace.organizationId,
                workspace_id: workspace.id,
                user_id: input.userId,
                feature: "ingestion",
                source_id: source.id,
              },
            },
            {
              idempotencyKey:
                input.idempotencyKey || `source-index:${source.id}:embeddings`,
              traceId: source.id,
            },
          )
          .catch((error: unknown) => {
            throw toContentServiceError(error);
          });

        embeddings = result.embeddings;
      }

      await replaceSourceDocumentsAndEmbeddings({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        sourceId: source.id,
        sourceTitle: source.title,
        sourceContentText: source.contentText,
        embeddingProfileId: profile.id,
        modelAlias: profile.modelAlias,
        embeddings,
        requestedDimensions: planner.requestedDimensions,
        chunks: chunkSpecs,
        parsingConfig: source.parsingConfig,
      });

      const billing = await billingService.meterIngestion(
        workspace.organizationId,
        {
          workspaceId: workspace.id,
          feature: "ingestion",
          referenceId: `source:${source.id}`,
          idempotencyKey: input.idempotencyKey || `source-index:${source.id}`,
          pages: input.estimatedPages,
          parsedTokens: input.parsedTokens,
        },
        input.userId,
      );

      const updatedSource = await updateSourceStatus({
        sourceId: source.id,
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        status: "indexed",
        indexedAt: new Date(),
        estimatedPages: input.estimatedPages ?? source.estimatedPages,
        parsedTokens: input.parsedTokens ?? source.parsedTokens,
      });

      return {
        source: updatedSource,
        billing,
        indexing: {
          chunkCount: chunkSpecs.length,
          embeddingProfileId: profile.id,
          vectorStrategy: planner.strategy,
          annIndexUsed: planner.annIndexUsed,
        },
      };
    } catch (error) {
      await updateSourceStatus({
        sourceId: source.id,
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        status: "failed",
        estimatedPages: input.estimatedPages ?? source.estimatedPages,
        parsedTokens: input.parsedTokens ?? source.parsedTokens,
      });
      throw error;
    }
  }

  async reparseSource(input: {
    workspaceId: string;
    sourceId: string;
    userId: string;
    chunkSize?: number;
  }) {
    const { workspace, source } = await requireSource(input);
    if (!source.storageKey) {
      throw new ContentError(400, "SOURCE_NOT_UPLOADED", "Source has no uploaded file to reparse");
    }

    const parsingConfig = defaultParsingConfig({
      chunkSize: input.chunkSize,
      parserVersion: source.parserVersion ?? DEFAULT_PARSER_VERSION,
    });

    const updatedSource = await updateSourceRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      sourceId: source.id,
      parsingConfig,
      status: "queued",
      error: {},
      metadata: mergeStatusMetadata(source, {
        progress: 10,
        currentStep: "queued",
        error: null,
      }),
    });

    if (!updatedSource) {
      throw new ContentError(500, "SOURCE_REPARSE_FAILED", "Failed to queue source reparse");
    }

    const revision = await createSourceRevisionRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      sourceId: source.id,
      contentHash: source.contentHash,
      storageBucket: source.storageBucket,
      storageKey: source.storageKey,
      parserVersion: parsingConfig.parserVersion,
    });

    const job = await enqueueSourceParseJob({
      sourceId: source.id,
      workspaceId: workspace.id,
      teamId: workspace.organizationId,
      userId: input.userId,
      idempotencyKey: `source-parse:${source.id}:${revision.revisionNo}`,
    });

    const queuedSource = await updateSourceRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      sourceId: source.id,
      metadata: mergeStatusMetadata(updatedSource, {
        progress: 10,
        currentStep: "queued",
        jobId: String(job.id),
      }),
    });

    return {
      source: queuedSource ?? updatedSource,
      status: (await getSourceStatusDetail({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        sourceId: source.id,
      }))!,
      revision,
    };
  }

  async processSourceParseJob(input: SourceParseJobPayload) {
    const source = await findSourceRecord({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
    });

    if (!source) {
      throw new ContentError(404, "SOURCE_NOT_FOUND", "Source not found");
    }

    if (!source.storageKey || !source.mimeType) {
      throw new ContentError(400, "SOURCE_STORAGE_MISSING", "Source file storage is incomplete");
    }

    const parser = getSourceParser(source.mimeType);
    if (!parser) {
      throw new ContentError(
        400,
        "UNSUPPORTED_SOURCE_TYPE",
        `Unsupported MIME type: ${source.mimeType}`,
      );
    }

    const parsingConfig = defaultParsingConfig(source.parsingConfig ?? undefined);

    await updateSourceStatus({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
      status: "processing",
      error: {},
      metadata: mergeStatusMetadata(source, {
        progress: 20,
        currentStep: "parsing",
      }),
    });

    try {
      const fileBuffer = await downloadSourceObject({
        bucket: source.storageBucket,
        key: source.storageKey,
      });
      const parsed = await parser.parse({
        fileName: source.metadata.fileName || source.title,
        mimeType: source.mimeType,
        fileSize: source.sizeBytes ?? fileBuffer.length,
        content: fileBuffer,
        config: parsingConfig,
      });

      const contentHash = computeContentHash(parsed.content);

      const parsedSource = await updateSourceRecord({
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        sourceId: input.sourceId,
        title: normalizeTitle(parsed.title, source.title),
        contentText: parsed.content,
        contentHash,
        parserVersion: parsingConfig.parserVersion,
        parsingConfig,
        estimatedPages: parsed.metadata.pageCount ?? source.estimatedPages,
        parsedTokens: estimateTokens(parsed.content),
        metadata: {
          ...(source.metadata ?? {}),
          ...parsed.metadata,
          parsedPages: parsed.pages.length,
          totalPages: parsed.metadata.pageCount ?? parsed.pages.length,
          progress: 60,
          currentStep: "chunking",
          error: null,
        },
      });

      if (!parsedSource) {
        throw new ContentError(500, "SOURCE_PARSE_FAILED", "Failed to update parsed source");
      }

      const result = await this.indexSource({
        workspaceId: input.workspaceId,
        sourceId: input.sourceId,
        userId: input.userId,
        estimatedPages: parsed.metadata.pageCount,
        parsedTokens: estimateTokens(parsed.content),
        idempotencyKey: input.idempotencyKey,
        chunks: parsed.chunks,
      });

      await updateSourceRecord({
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        sourceId: input.sourceId,
        metadata: mergeStatusMetadata(result.source, {
          parsedPages: parsed.pages.length,
          totalPages: parsed.metadata.pageCount ?? parsed.pages.length,
          progress: 100,
          currentStep: "completed",
          error: null,
        }),
        error: {},
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Source parse failed";
      await updateSourceStatus({
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        sourceId: input.sourceId,
        status: "failed",
        error: {
          message,
        },
        metadata: {
          ...(source.metadata ?? {}),
          progress: 100,
          currentStep: "failed",
          error: message,
        },
      });
      throw error;
    }
  }

  async listByokKeyRefs(input: {
    workspaceId: string;
    userId: string;
  }) {
    const workspace = await requireWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });

    const items = await listByokKeyRefRecords({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      userId: input.userId,
    });

    return { items };
  }

  async createByokKeyRef(input: {
    workspaceId: string;
    userId: string;
    providerName: string;
    keyRef: string;
    apiKey: string;
    metadata?: Record<string, unknown>;
  }) {
    const workspace = await requireWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });

    const item = await createByokKeyRefRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      userId: input.userId,
      providerName: input.providerName,
      keyRef: input.keyRef,
      apiKeyEncrypted: encryptSecret(
        input.apiKey,
        sharedConfig.modelGatewayEncryptionSecret,
      ),
      metadata: input.metadata,
    });

    return { item };
  }

  async deleteByokKeyRef(input: {
    workspaceId: string;
    userId: string;
    providerName: string;
    keyRef: string;
  }) {
    const workspace = await requireWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });

    const deleted = await deleteByokKeyRefRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      userId: input.userId,
      providerName: input.providerName,
      keyRef: input.keyRef,
    });

    if (!deleted) {
      throw new ContentError(404, "BYOK_KEY_REF_NOT_FOUND", "BYOK key ref not found");
    }

    return { deleted: true as const, keyRef: input.keyRef };
  }

  async listThreads(input: {
    workspaceId: string;
    userId: string;
    limit?: number;
    cursor?: string;
  }) {
    const workspace = await requireWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });

    const limit = input.limit ?? DEFAULT_THREAD_PAGE_LIMIT;
    const decodedCursor = input.cursor ? decodeThreadsCursor(input.cursor) : undefined;

    const items = await listThreadRecordsByWorkspace({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      limit: limit + 1,
      cursor: decodedCursor,
    });

    const pageItems = items.slice(0, limit);
    const hasMore = items.length > limit;
    const lastVisible = pageItems[pageItems.length - 1] ?? null;
    const nextCursor =
      hasMore && lastVisible
        ? encodeThreadsCursor({
            id: lastVisible.id,
            updatedAt: lastVisible.updatedAt,
          })
        : null;

    return { items: pageItems, nextCursor };
  }

  private async validateThreadModelSettings(settings: ThreadModelSettings) {
    for (const [threadKind, profileKind] of Object.entries(MODEL_KIND_BY_THREAD_KIND) as Array<
      [ThreadModelKind, ModelProfileKind]
    >) {
      const alias =
        threadKind === "llm"
          ? settings.llmProfileAlias
          : threadKind === "image"
            ? settings.imageProfileAlias
            : settings.visionProfileAlias;

      if (!alias) {
        continue;
      }

      await ensureProfileAliasExists({
        profileKind,
        modelAlias: alias,
      });
    }
  }

  async getThread(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
  }) {
    const workspace = await requireWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });

    const thread = await findThreadRecord({
      threadId: input.threadId,
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
    });

    if (!thread) {
      throw new ContentError(404, "THREAD_NOT_FOUND", "Thread not found");
    }

    return { thread };
  }

  async updateThreadModelSettings(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    llmProfileAlias?: string | null;
    imageProfileAlias?: string | null;
    visionProfileAlias?: string | null;
  }) {
    const workspace = await requireWorkspace({
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

    const patch = {
      llmProfileAlias: input.llmProfileAlias,
      imageProfileAlias: input.imageProfileAlias,
      visionProfileAlias: input.visionProfileAlias,
    };
    const currentSettings = normalizeThreadModelSettings(thread.modelSettings);
    const sanitizedCurrentSettings = await pruneUnavailableThreadModelAliases(
      currentSettings,
      patch,
    );

    const nextSettings = mergeThreadModelSettings(sanitizedCurrentSettings, patch);

    await this.validateThreadModelSettings(nextSettings);

    const updated = await updateThreadModelSettingsRecord({
      threadId: thread.id,
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      modelSettings: nextSettings,
    });

    if (!updated) {
      throw new ContentError(500, "THREAD_UPDATE_FAILED", "Failed to update thread settings");
    }

    return { thread: updated };
  }

  async listThreadModelCatalog(input: {
    workspaceId: string;
    userId: string;
  }) {
    await requireWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });

    const profileKinds: ModelProfileKind[] = ["chat", "image", "vision"];
    const profileRows = await db
      .select({
        kind: modelGatewayProfiles.kind,
        profileAlias: modelGatewayProfiles.profileAlias,
        modelAlias: modelGatewayProfiles.modelAlias,
        isDefault: modelGatewayProfiles.isDefault,
        isActive: modelGatewayProfiles.isActive,
        configJson: modelGatewayProfiles.configJson,
      })
      .from(modelGatewayProfiles)
      .where(
        and(
          eq(modelGatewayProfiles.isActive, true),
          inArray(modelGatewayProfiles.kind, profileKinds),
        ),
      );

    const [activeVersion] = await db
      .select({ id: modelGatewayConfigVersions.id })
      .from(modelGatewayConfigVersions)
      .where(eq(modelGatewayConfigVersions.isActive, true))
      .limit(1);

    const routeByKindAlias = new Map<
      string,
      {
        providerName: string;
        providerKind: string;
        targetModel: string;
      }
    >();

    if (activeVersion) {
      const [routeRows, providerRows] = await Promise.all([
        db
          .select({
            routeKind: modelGatewayRoutes.routeKind,
            alias: modelGatewayRoutes.alias,
            targetProviderName: modelGatewayRoutes.targetProviderName,
            targetModel: modelGatewayRoutes.targetModel,
            priority: modelGatewayRoutes.priority,
            weight: modelGatewayRoutes.weight,
          })
          .from(modelGatewayRoutes)
          .where(
            and(
              eq(modelGatewayRoutes.configVersionId, activeVersion.id),
              eq(modelGatewayRoutes.isActive, true),
              inArray(modelGatewayRoutes.routeKind, profileKinds),
            ),
          ),
        db
          .select({
            providerName: modelGatewayProviderConfigs.providerName,
            providerKind: modelGatewayProviderConfigs.providerKind,
          })
          .from(modelGatewayProviderConfigs)
          .where(
            and(
              eq(modelGatewayProviderConfigs.configVersionId, activeVersion.id),
              eq(modelGatewayProviderConfigs.isActive, true),
            ),
          ),
      ]);

      const providerKindByName = new Map(
        providerRows.map((row) => [row.providerName, row.providerKind]),
      );

      routeRows
        .sort((left, right) => {
          if (left.priority !== right.priority) {
            return left.priority - right.priority;
          }
          return right.weight - left.weight;
        })
        .forEach((route) => {
          const key = `${route.routeKind}:${route.alias}`;
          if (routeByKindAlias.has(key)) {
            return;
          }

          routeByKindAlias.set(key, {
            providerName: route.targetProviderName,
            providerKind:
              providerKindByName.get(route.targetProviderName) ?? "unknown",
            targetModel: route.targetModel,
          });
        });
    }

    const defaults: ThreadModelSettings = {
      llmProfileAlias: null,
      imageProfileAlias: null,
      visionProfileAlias: null,
    };

    const kinds = {
      llm: [] as Array<{
        kind: "llm" | "image" | "vision";
        profileAlias: string;
        modelAlias: string;
        providerName: string;
        providerKind: string;
        targetModel: string | null;
        isDefault: boolean;
        isActive: boolean;
        displayName: string;
        subtitle: string;
        badges: string[];
        pricing: Record<string, unknown> | null;
      }>,
      image: [] as Array<{
        kind: "llm" | "image" | "vision";
        profileAlias: string;
        modelAlias: string;
        providerName: string;
        providerKind: string;
        targetModel: string | null;
        isDefault: boolean;
        isActive: boolean;
        displayName: string;
        subtitle: string;
        badges: string[];
        pricing: Record<string, unknown> | null;
      }>,
      vision: [] as Array<{
        kind: "llm" | "image" | "vision";
        profileAlias: string;
        modelAlias: string;
        providerName: string;
        providerKind: string;
        targetModel: string | null;
        isDefault: boolean;
        isActive: boolean;
        displayName: string;
        subtitle: string;
        badges: string[];
        pricing: Record<string, unknown> | null;
      }>,
    };

    for (const row of profileRows) {
      const profileKind = row.kind as ModelProfileKind;
      const threadKind = THREAD_KIND_BY_MODEL_KIND[profileKind];
      const route = routeByKindAlias.get(`${profileKind}:${row.modelAlias}`);
      const configJson =
        row.configJson && typeof row.configJson === "object"
          ? (row.configJson as Record<string, unknown>)
          : {};
      const isGlobalDefaultAlias =
        row.modelAlias === "chat-default" ||
        row.modelAlias === "image-default" ||
        row.modelAlias === "vision-default";
      const displayName =
        isGlobalDefaultAlias
          ? "Auto (Default)"
          : typeof configJson.displayName === "string" && configJson.displayName.trim().length > 0
            ? configJson.displayName.trim()
            : row.modelAlias;
      const subtitle =
        isGlobalDefaultAlias
          ? "Global models"
          : typeof configJson.subtitle === "string" && configJson.subtitle.trim().length > 0
            ? configJson.subtitle.trim()
            : route?.targetModel ?? row.modelAlias;
      const badges = Array.isArray(configJson.badges)
        ? configJson.badges.filter(
            (badge): badge is string =>
              typeof badge === "string" && badge.trim().length > 0,
          )
        : [];
      const pricing =
        typeof configJson.price_source === "string"
          ? configJson
          : null;

      const entry = {
        kind: threadKind,
        profileAlias: row.profileAlias,
        modelAlias: row.modelAlias,
        providerName: route?.providerName ?? "unknown",
        providerKind: route?.providerKind ?? "unknown",
        targetModel: route?.targetModel ?? null,
        isDefault: row.isDefault,
        isActive: row.isActive,
        displayName,
        subtitle,
        badges,
        pricing,
      };

      kinds[threadKind].push(entry);

      if (row.isDefault) {
        if (threadKind === "llm") {
          defaults.llmProfileAlias = row.modelAlias;
        }
        if (threadKind === "image") {
          defaults.imageProfileAlias = row.modelAlias;
        }
        if (threadKind === "vision") {
          defaults.visionProfileAlias = row.modelAlias;
        }
      }
    }

    const dedupeByTarget = <T extends {
      isDefault: boolean;
      providerName: string;
      targetModel: string | null;
      modelAlias: string;
      displayName: string;
    }>(items: T[]) => {
      const indexByTargetKey = new Map<string, number>();
      const deduped: T[] = [];

      for (const item of items) {
        if (item.isDefault) {
          deduped.push(item);
          continue;
        }

        const provider = item.providerName.trim().toLowerCase();
        const target = (item.targetModel ?? item.modelAlias).trim().toLowerCase();
        if (!provider || !target) {
          deduped.push(item);
          continue;
        }

        const dedupeKey = `${provider}:${target}`;
        const existingIndex = indexByTargetKey.get(dedupeKey);
        if (existingIndex === undefined) {
          indexByTargetKey.set(dedupeKey, deduped.length);
          deduped.push(item);
          continue;
        }

        const existing = deduped[existingIndex]!;
        const existingHasReadableName =
          existing.displayName.trim().toLowerCase() !==
          existing.modelAlias.trim().toLowerCase();
        const currentHasReadableName =
          item.displayName.trim().toLowerCase() !== item.modelAlias.trim().toLowerCase();
        if (!existingHasReadableName && currentHasReadableName) {
          deduped[existingIndex] = item;
        }
      }

      return deduped;
    };

    kinds.llm = dedupeByTarget(kinds.llm);
    kinds.image = dedupeByTarget(kinds.image);
    kinds.vision = dedupeByTarget(kinds.vision);

    const sorter = (left: { isDefault: boolean; displayName: string }, right: { isDefault: boolean; displayName: string }) => {
      if (left.isDefault !== right.isDefault) {
        return left.isDefault ? -1 : 1;
      }
      return left.displayName.localeCompare(right.displayName);
    };
    kinds.llm.sort(sorter);
    kinds.image.sort(sorter);
    kinds.vision.sort(sorter);

    return {
      defaults,
      kinds,
    };
  }

  async createThread(input: {
    workspaceId: string;
    userId: string;
    title?: string;
    modelSettings?: {
      llmProfileAlias?: string | null;
      imageProfileAlias?: string | null;
      visionProfileAlias?: string | null;
    };
  }) {
    const workspace = await requireWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });

    const modelSettings = normalizeThreadModelSettings(input.modelSettings);
    await this.validateThreadModelSettings(modelSettings);

    const thread = await createThreadRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      title: normalizeTitle(input.title, "New Thread"),
      createdBy: input.userId,
      modelSettings,
    });

    return { thread };
  }

  async getCitationDetail(input: {
    workspaceId: string;
    messageId: string;
    rank: number;
    userId: string;
  }) {
    const workspace = await requireWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });

    const citation = await findCitationByMessageRank({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      messageId: input.messageId,
      rank: input.rank,
    });

    if (!citation) {
      throw new ContentError(404, "CITATION_NOT_FOUND", "Citation not found");
    }

    return {
      citation: {
        id: citation.id,
        messageId: citation.messageId,
        rank: citation.rank,
        score: citation.score,
        sourceId: citation.sourceId,
        sourceTitle: citation.sourceTitle,
        chunkId: citation.chunkId,
        excerpt: citation.quoteText ?? citation.chunkContent ?? "",
        chunkContent: citation.chunkContent ?? "",
      },
    };
  }

  async listThreadMessages(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
  }) {
    const workspace = await requireWorkspace({
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

    const items = await listMessageRecordsByThread({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      threadId: thread.id,
    });

    return { items };
  }

  private async resolveTurnContext(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    userMessageId?: string;
    assistantMessageId?: string;
  }) {
    const workspace = await requireWorkspace({
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

    const allMessages = await listMessageRecordsByThread({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      threadId: thread.id,
    });

    if (!input.userMessageId && !input.assistantMessageId) {
      const messages = collapseSupersededMessages(allMessages);
      const { latestUserMessage, latestAssistantMessage } =
        resolveLatestThreadTurn(messages);

      return {
        workspace,
        thread,
        latestUserMessage,
        latestAssistantMessage,
      };
    }

    const messageById = new Map(allMessages.map((message) => [message.id, message]));
    const requestedUserMessage = input.userMessageId
      ? messageById.get(input.userMessageId)
      : undefined;
    const requestedAssistantMessage = input.assistantMessageId
      ? messageById.get(input.assistantMessageId)
      : undefined;

    if (input.userMessageId && !requestedUserMessage) {
      throw new ContentError(404, "MESSAGE_NOT_FOUND", "User message not found");
    }
    if (input.assistantMessageId && !requestedAssistantMessage) {
      throw new ContentError(
        404,
        "MESSAGE_NOT_FOUND",
        "Assistant message not found",
      );
    }

    ensureMessageIsInThread(requestedUserMessage, thread.id, "INVALID_USER_MESSAGE");
    ensureMessageIsInThread(
      requestedAssistantMessage,
      thread.id,
      "INVALID_ASSISTANT_MESSAGE",
    );

    if (requestedUserMessage && requestedUserMessage.role !== "user") {
      throw new ContentError(400, "INVALID_USER_MESSAGE", "Message is not a user message");
    }
    if (requestedAssistantMessage && requestedAssistantMessage.role !== "assistant") {
      throw new ContentError(
        400,
        "INVALID_ASSISTANT_MESSAGE",
        "Message is not an assistant message",
      );
    }

    const userMessage = requestedUserMessage
      ? requestedUserMessage
      : requestedAssistantMessage
        ? resolveUserForAssistantMessage(allMessages, requestedAssistantMessage)
        : null;
    const assistantMessage = requestedAssistantMessage
      ? requestedAssistantMessage
      : requestedUserMessage
        ? resolveAssistantForUserMessage(allMessages, requestedUserMessage)
        : null;

    return {
      userId: input.userId,
      workspace,
      thread,
      latestUserMessage: userMessage,
      latestAssistantMessage: assistantMessage,
    };
  }

  private async prepareThreadTurn(input: StreamThreadEventInput): Promise<PreparedThreadTurn> {
    const messageContent =
      input.existingUserMessage?.content.trim() ?? input.content.trim();
    if (!messageContent) {
      throw new ContentError(
        400,
        "EMPTY_MESSAGE",
        "content is required for thread stream",
      );
    }

    const workspace = await requireWorkspace({
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
      typeof input.llm?.modelAlias === "string"
        ? input.llm.modelAlias.trim()
        : "";

    const resolvedChatModel = await resolveThreadChatModelAlias({
      threadModelSettings: normalizeThreadModelSettings(thread.modelSettings),
      requestedModelAlias: requestedModelAlias || undefined,
    });

    if (
      requestedModelAlias.length > 0 &&
      thread.modelSettings.llmProfileAlias !== requestedModelAlias
    ) {
      const updatedThread = await updateThreadModelSettingsRecord({
        threadId: thread.id,
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        modelSettings: mergeThreadModelSettings(
          normalizeThreadModelSettings(thread.modelSettings),
          { llmProfileAlias: requestedModelAlias },
        ),
      });
      if (updatedThread) {
        thread = updatedThread;
      }
    }

    const implicitRefresh = await resolveImplicitRefreshInput({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      threadId: thread.id,
      messageContent,
      sourceIds: dedupeSourceIds(input.sourceIds),
      existingUserMessage: input.existingUserMessage,
      userMessageParentId: input.userMessageParentId,
      assistantMessageParentId: input.assistantMessageParentId,
    });

    const sourceIds = dedupeSourceIds(implicitRefresh.sourceIds);
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
          sourceIds,
          versionOf: input.userMessageParentId ?? null,
        },
      }));

    const retrieval = await runRetrieval({
      workspaceId: workspace.id,
      teamId: workspace.organizationId,
      threadId: thread.id,
      userId: input.userId,
      userMessageId: userMessage.id,
      queryText: messageContent,
      sourceIds,
      idempotencyKey: input.idempotencyKey,
      llm: input.llm,
    });

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
      assistantMessageParentId,
    });

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
      deepAgentThreadId,
    };
  }

  private async finalizeThreadTurn(input: {
    prepared: PreparedThreadTurn;
    retrieval: Awaited<ReturnType<typeof runRetrieval>>;
    retrievalCalls: RetrievalCallTrace[];
    toolCalls: ToolCallTrace[];
    llm?: LlmExecutionConfig;
    operation: "chat.stream" | "chat.complete";
    assistantContent: string;
    usage?: UsageInfo;
    finishReason?: string;
    reasoning?: string;
    providerFields?: Record<string, unknown>;
    routeDecision?: Record<string, unknown>;
    provider?: string | null;
    providerModel?: string | null;
    latencyMs: number;
    modelForMessage?: string | null;
  }) {
    const { prepared, retrieval } = input;
    const providerCostUsd = await computeProviderCost({
      gatewayConfigId: prepared.chatProfile.gatewayConfigId,
      modelAlias: prepared.modelAlias,
      userContent: prepared.messageContent,
      assistantContent: input.assistantContent,
      usage: input.usage,
    });

    await recordGatewayOperationEvent({
      teamId: prepared.workspace.organizationId,
      workspaceId: prepared.workspace.id,
      userId: prepared.userId,
      threadId: prepared.thread.id,
      messageId: prepared.userMessage.id,
      feature: "chat",
      operation: input.operation,
      modelKind: "chat",
      modelAlias: prepared.modelAlias,
      llm: input.llm,
      provider: input.provider ?? null,
      providerModel: input.providerModel ?? null,
      routeDecision: input.routeDecision,
      usage: input.usage,
      providerCostUsd,
      traceId: prepared.userMessage.id,
      success: true,
      latencyMs: input.latencyMs,
      attributes: {
        retrievalCalls: summarizeRetrievalCalls(input.retrievalCalls),
      },
    });

    const billing = await billingService.meterConsume(
      prepared.workspace.organizationId,
      {
        workspaceId: prepared.workspace.id,
        feature: "chat",
        referenceId: `thread:${prepared.thread.id}:message:${prepared.userMessage.id}`,
        idempotencyKey: prepared.llmIdempotencyKey,
        providerCostUsd,
        platformCostUsd: 0.00005,
      },
      prepared.userId,
    );

    const assistantMessage = await createMessageRecord({
      teamId: prepared.workspace.organizationId,
      workspaceId: prepared.workspace.id,
      threadId: prepared.thread.id,
      parentMessageId: prepared.assistantMessageParentId,
      role: "assistant",
      content: input.assistantContent,
      createdBy: null,
      model: input.modelForMessage || prepared.modelAlias,
      creditsConsumed: billing.consumedCredits,
      metadata: {
        userMessageId: prepared.userMessage.id,
        providerCostUsd,
        modelAlias: prepared.modelAlias,
        finishReason: input.finishReason,
        usage: input.usage,
        reasoning: input.reasoning,
        providerFields: input.providerFields,
        versionOf: prepared.assistantMessageParentId,
        gateway: buildGatewayAuditMetadata({
          llm: input.llm,
          provider: input.provider ?? undefined,
          providerModel: input.providerModel ?? undefined,
          routeDecision: input.routeDecision,
        }),
        toolCalls: input.toolCalls.map((call) => ({
          id: call.id,
          tool: call.tool,
          input: call.input,
          output: call.output,
          status: call.status,
          latencyMs: call.latencyMs,
          error: call.error,
        })),
        retrieval: {
          embeddingProfileId: retrieval.profile.id,
          vectorStrategy: retrieval.planner.strategy,
          annIndexUsed: retrieval.planner.annIndexUsed,
          citations: retrieval.retrievalSummary,
        },
      },
    });

    await createCitationRecords({
      teamId: prepared.workspace.organizationId,
      workspaceId: prepared.workspace.id,
      threadId: prepared.thread.id,
      messageId: assistantMessage.id,
      citations: retrieval.fusedCandidates.map((candidate, index) => ({
        sourceId: candidate.sourceId,
        documentId: candidate.documentId,
        chunkId: candidate.chunkId,
        quoteText: candidate.content.slice(0, 400),
        rank: index + 1,
        score: candidate.score,
      })),
    });

    return {
      assistantMessage,
      billing,
    };
  }

  private async *invokeDeepAgentTurn(input: {
    prepared: PreparedThreadTurn;
    llm?: LlmExecutionConfig;
  }): AsyncGenerator<DeepAgentTurnEvent> {
    const retrievalCallsById = new Map<string, RetrievalCallTrace>();
    const retrievalCallOrder: string[] = [];
    const toolCallsById = new Map<string, ToolCallTrace>();
    const toolCallOrder: string[] = [];
    const toolStartedAtById = new Map<string, number>();
    let latestToolRetrieval: Awaited<ReturnType<typeof runToolRetrieval>> | null =
      null;
    let assistantContent = "";
    let fallbackAssistantContent: string | null = null;

    const retrievalTool = createRetrievalTool({
      retrieve: async (query, runtime) => {
        const retrievalStartedAt = Date.now();
        const retrieval = await runToolRetrieval({
          prepared: input.prepared,
          query,
          llm: input.llm,
        });
        latestToolRetrieval = retrieval;

        const callId = resolveToolCallId({
          toolCallId: runtime?.toolCallId,
          toolName: "retrieve",
          fallbackIndex: retrievalCallOrder.length + 1,
        });

        if (!retrievalCallsById.has(callId)) {
          retrievalCallOrder.push(callId);
        }

        const retrievalCall: RetrievalCallTrace = {
          id: callId,
          tool: "retrieve",
          query,
          hitCount: retrieval.fusedCandidates.length,
          latencyMs: Date.now() - retrievalStartedAt,
        };
        retrievalCallsById.set(callId, retrievalCall);

        if (!toolCallsById.has(callId)) {
          toolCallOrder.push(callId);
          toolCallsById.set(callId, {
            id: callId,
            tool: "retrieve",
            input: { query },
            output: {
              hitCount: retrievalCall.hitCount,
            },
            status: "completed",
            latencyMs: retrievalCall.latencyMs,
            error: null,
          });
        }

        return retrieval.fusedCandidates.map((candidate) => ({
          chunkId: candidate.chunkId,
          content: candidate.content,
        }));
      },
    });

    const agent = await createThreadAgent({
      modelAlias: input.prepared.modelAlias,
      gatewayConfigId: input.prepared.chatProfile.gatewayConfigId,
      tools: [retrievalTool],
      execution: {
        executionMode: input.llm?.executionMode,
        providerHint: input.llm?.providerHint,
        byok: input.llm?.byok,
        metadata: {
          team_id: input.prepared.workspace.organizationId,
          workspace_id: input.prepared.workspace.id,
          user_id: input.prepared.userId,
          thread_id: input.prepared.thread.id,
          message_id: input.prepared.userMessage.id,
          feature: "chat",
        },
      },
    });

    const stream = await agent.stream(
      {
        messages: [
          {
            role: "user",
            content: input.prepared.messageContent,
          },
        ],
      },
      {
        ...buildAgentConfig(input.prepared.deepAgentThreadId, {
          team_id: input.prepared.workspace.organizationId,
          workspace_id: input.prepared.workspace.id,
          user_id: input.prepared.userId,
          thread_id: input.prepared.thread.id,
        }),
        streamMode: ["messages", "tools", "updates"],
      },
    );

    for await (const streamChunk of stream as AsyncGenerator<unknown>) {
      if (!Array.isArray(streamChunk) || streamChunk.length < 2) {
        continue;
      }

      const mode = streamChunk[0];
      const payload = streamChunk[1];

      if (mode === "messages") {
        if (!Array.isArray(payload) || payload.length < 1) {
          continue;
        }

        const messageChunk = payload[0];
        const deltas = extractTextDeltasFromMessageChunk(messageChunk);
        for (const delta of deltas) {
          if (!delta) {
            continue;
          }
          assistantContent += delta;
          yield {
            type: "text-delta",
            delta,
          };
        }
        continue;
      }

      if (mode === "updates") {
        const assistantFromUpdates = resolveAssistantContentFromUpdatesChunk(payload);
        if (assistantFromUpdates && assistantFromUpdates.trim().length > 0) {
          fallbackAssistantContent = assistantFromUpdates.trim();
        }
        continue;
      }

      if (mode !== "tools") {
        continue;
      }

      const toolPayload = toObjectRecord(payload);
      if (!toolPayload) {
        continue;
      }

      const event = typeof toolPayload.event === "string" ? toolPayload.event : "";
      const toolName =
        typeof toolPayload.name === "string" && toolPayload.name.length > 0
          ? toolPayload.name
          : "tool";
      const toolCallId = resolveToolCallId({
        toolCallId:
          typeof toolPayload.toolCallId === "string" ? toolPayload.toolCallId : undefined,
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
          status: "running",
          latencyMs: null,
          error: null,
        });
      }

      const currentToolCall = toolCallsById.get(toolCallId);
      if (!currentToolCall) {
        continue;
      }

      if (event === "on_tool_start") {
        const normalizedInput = normalizeToolInput(toolPayload.input);
        toolStartedAtById.set(toolCallId, Date.now());
        const nextToolCall: ToolCallTrace = {
          ...currentToolCall,
          tool: toolName,
          input: normalizedInput,
          status: "running",
          error: null,
        };
        toolCallsById.set(toolCallId, nextToolCall);
        yield {
          type: "tool-call-start",
          id: toolCallId,
          tool: toolName,
          input: normalizedInput,
          toolCall: nextToolCall,
        };
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
        const retrievalCall = retrievalCallsById.get(toolCallId);
        const startedAt = toolStartedAtById.get(toolCallId);
        const measuredLatency =
          typeof startedAt === "number" ? Date.now() - startedAt : null;
        const latencyMs = retrievalCall?.latencyMs ?? measuredLatency;
        const output =
          retrievalCall
            ? {
                hitCount: retrievalCall.hitCount,
              }
            : toolPayload.output;
        const nextToolCall: ToolCallTrace = {
          ...currentToolCall,
          tool: toolName,
          output,
          status: "completed",
          latencyMs,
          error: null,
        };
        toolCallsById.set(toolCallId, nextToolCall);
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
        yield {
          type: "tool-call-end",
          id: toolCallId,
          tool: toolName,
          latencyMs,
          status: "completed",
          toolCall: nextToolCall,
        };
        continue;
      }

      if (event === "on_tool_error") {
        const startedAt = toolStartedAtById.get(toolCallId);
        const latencyMs =
          typeof startedAt === "number" ? Date.now() - startedAt : currentToolCall.latencyMs;
        const errorText = normalizeErrorText(toolPayload.error);
        const nextToolCall: ToolCallTrace = {
          ...currentToolCall,
          tool: toolName,
          status: "error",
          latencyMs,
          error: errorText,
        };
        toolCallsById.set(toolCallId, nextToolCall);
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
      }
    }

    const assistantText =
      assistantContent.trim().length > 0
        ? assistantContent.trim()
        : fallbackAssistantContent && fallbackAssistantContent.trim().length > 0
          ? fallbackAssistantContent.trim()
          : "Model returned an empty response.";

    const finalRetrieval =
      latestToolRetrieval ??
      (await runToolRetrieval({
        prepared: input.prepared,
        query: input.prepared.messageContent,
        llm: input.llm,
      }));

    const retrievalCalls = retrievalCallOrder
      .map((callId) => retrievalCallsById.get(callId))
      .filter((call): call is RetrievalCallTrace => Boolean(call));

    const toolCalls = toolCallOrder
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
            call.latencyMs ?? (typeof startedAt === "number" ? Date.now() - startedAt : null),
        };
      });

    yield {
      type: "done",
      outcome: {
        assistantContent: assistantText,
        retrieval: finalRetrieval,
        retrievalCalls,
        toolCalls,
      },
    };
  }

  async refreshThread(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    sourceIds?: string[];
    userMessageId?: string;
    assistantMessageId?: string;
    idempotencyKey?: string;
    llm?: LlmExecutionConfig;
  }) {
    const { latestUserMessage, latestAssistantMessage } =
      await this.resolveTurnContext(input);

    if (!latestUserMessage || !latestAssistantMessage) {
      throw new ContentError(
        400,
        "THREAD_REFRESH_NOT_AVAILABLE",
        "No completed assistant response available to refresh",
      );
    }

    const sourceIds =
      dedupeSourceIds(input.sourceIds).length > 0
        ? dedupeSourceIds(input.sourceIds)
        : resolveSourceIdsFromMessage(latestUserMessage);

    return this.streamThread({
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      userId: input.userId,
      content: latestUserMessage.content,
      sourceIds,
      idempotencyKey: input.idempotencyKey,
      llm: input.llm,
      existingUserMessage: latestUserMessage,
      assistantMessageParentId: latestAssistantMessage.id,
    });
  }

  async *refreshThreadEvents(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    sourceIds?: string[];
    userMessageId?: string;
    assistantMessageId?: string;
    idempotencyKey?: string;
    llm?: LlmExecutionConfig;
  }): AsyncGenerator<string> {
    const { latestUserMessage, latestAssistantMessage } =
      await this.resolveTurnContext(input);

    if (!latestUserMessage || !latestAssistantMessage) {
      throw new ContentError(
        400,
        "THREAD_REFRESH_NOT_AVAILABLE",
        "No completed assistant response available to refresh",
      );
    }

    const sourceIds =
      dedupeSourceIds(input.sourceIds).length > 0
        ? dedupeSourceIds(input.sourceIds)
        : resolveSourceIdsFromMessage(latestUserMessage);

    yield* this.streamThreadEvents({
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      userId: input.userId,
      content: latestUserMessage.content,
      sourceIds,
      idempotencyKey: input.idempotencyKey,
      llm: input.llm,
      existingUserMessage: latestUserMessage,
      assistantMessageParentId: latestAssistantMessage.id,
    });
  }

  async editThread(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    content: string;
    sourceIds?: string[];
    userMessageId?: string;
    assistantMessageId?: string;
    idempotencyKey?: string;
    llm?: LlmExecutionConfig;
  }) {
    const { latestUserMessage, latestAssistantMessage } =
      await this.resolveTurnContext(input);

    if (!latestUserMessage) {
      throw new ContentError(
        400,
        "THREAD_EDIT_NOT_AVAILABLE",
        "No user message available to edit",
      );
    }

    const sourceIds =
      dedupeSourceIds(input.sourceIds).length > 0
        ? dedupeSourceIds(input.sourceIds)
        : resolveSourceIdsFromMessage(latestUserMessage);

    return this.streamThread({
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      userId: input.userId,
      content: input.content,
      sourceIds,
      idempotencyKey: input.idempotencyKey,
      llm: input.llm,
      userMessageParentId: latestUserMessage.id,
      assistantMessageParentId: latestAssistantMessage?.id ?? null,
    });
  }

  async *editThreadEvents(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    content: string;
    sourceIds?: string[];
    userMessageId?: string;
    assistantMessageId?: string;
    idempotencyKey?: string;
    llm?: LlmExecutionConfig;
  }): AsyncGenerator<string> {
    const { latestUserMessage, latestAssistantMessage } =
      await this.resolveTurnContext(input);

    if (!latestUserMessage) {
      throw new ContentError(
        400,
        "THREAD_EDIT_NOT_AVAILABLE",
        "No user message available to edit",
      );
    }

    const sourceIds =
      dedupeSourceIds(input.sourceIds).length > 0
        ? dedupeSourceIds(input.sourceIds)
        : resolveSourceIdsFromMessage(latestUserMessage);

    yield* this.streamThreadEvents({
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      userId: input.userId,
      content: input.content,
      sourceIds,
      idempotencyKey: input.idempotencyKey,
      llm: input.llm,
      userMessageParentId: latestUserMessage.id,
      assistantMessageParentId: latestAssistantMessage?.id ?? null,
    });
  }

  async *streamThreadEvents(input: StreamThreadEventInput): AsyncGenerator<string> {
    const prepared = await this.prepareThreadTurn(input);
    const chatStartedAt = Date.now();

    const textId = `text-${prepared.userMessage.id}`;
    yield toSseData({ type: "start", messageId: prepared.userMessage.id });
    yield toSseData({ type: "text-start", id: textId });

    let streamError: Error | undefined;

    try {
      let outcome: DeepAgentTurnOutcome | null = null;

      for await (const event of this.invokeDeepAgentTurn({
        prepared,
        llm: input.llm,
      })) {
        if (event.type === "text-delta") {
          yield toSseData({ type: "text-delta", id: textId, delta: event.delta });
          continue;
        }

        if (event.type === "tool-call-start") {
          yield toSseData({
            type: "tool-call-start",
            id: event.id,
            tool: event.tool,
            input: event.input,
            toolCall: event.toolCall,
          });
          continue;
        }

        if (event.type === "tool-call-event") {
          yield toSseData({
            type: "tool-call-event",
            id: event.id,
            tool: event.tool,
            data: event.data,
            toolCall: event.toolCall,
          });
          continue;
        }

        if (event.type === "tool-call-result") {
          yield toSseData({
            type: "tool-call-result",
            id: event.id,
            tool: event.tool,
            input: event.input,
            output: event.output,
            latencyMs: event.latencyMs,
            toolCall: event.toolCall,
            ...(event.query
              ? {
                  query: event.query,
                }
              : {}),
            ...(typeof event.hitCount === "number"
              ? {
                  hitCount: event.hitCount,
                }
              : {}),
          });
          continue;
        }

        if (event.type === "tool-call-error") {
          yield toSseData({
            type: "tool-call-error",
            id: event.id,
            tool: event.tool,
            input: event.input,
            error: event.error,
            latencyMs: event.latencyMs,
            toolCall: event.toolCall,
          });
          continue;
        }

        if (event.type === "tool-call-end") {
          yield toSseData({
            type: "tool-call-end",
            id: event.id,
            tool: event.tool,
            status: event.status,
            latencyMs: event.latencyMs,
            toolCall: event.toolCall,
          });
          continue;
        }

        if (event.type === "done") {
          outcome = event.outcome;
        }
      }

      if (!outcome) {
        throw new ContentError(502, "MODEL_EMPTY_RESPONSE", "Model returned no response");
      }

      const { assistantMessage } = await this.finalizeThreadTurn({
        prepared,
        retrieval: outcome.retrieval,
        retrievalCalls: outcome.retrievalCalls,
        toolCalls: outcome.toolCalls,
        llm: input.llm,
        operation: "chat.stream",
        assistantContent: outcome.assistantContent,
        latencyMs: Date.now() - chatStartedAt,
      });

      yield toSseData({ type: "text-end", id: textId });
      yield toSseData({ type: "assistant-message", messageId: assistantMessage.id });
    } catch (error) {
      const contentError =
        error instanceof ContentError ? error : toContentServiceError(error);
      streamError = contentError;

      await recordGatewayOperationEvent({
        teamId: prepared.workspace.organizationId,
        workspaceId: prepared.workspace.id,
        userId: prepared.userId,
        threadId: prepared.thread.id,
        messageId: prepared.userMessage.id,
        feature: "chat",
        operation: "chat.stream",
        modelKind: "chat",
        modelAlias: prepared.modelAlias,
        llm: input.llm,
        traceId: prepared.userMessage.id,
        success: false,
        errorCode: contentError.code,
        errorMessage: contentError.message,
        attributes: {
          retrievalCalls: summarizeRetrievalCalls([]),
        },
      });
    }

    yield toSseData({ type: "finish" });

    if (streamError) {
      throw streamError;
    }
  }
  async streamThread(input: StreamThreadEventInput) {
    const prepared = await this.prepareThreadTurn(input);
    const chatStartedAt = Date.now();

    const outcome = await (async () => {
      let doneOutcome: DeepAgentTurnOutcome | null = null;
      for await (const event of this.invokeDeepAgentTurn({
        prepared,
        llm: input.llm,
      })) {
        if (event.type === "done") {
          doneOutcome = event.outcome;
        }
      }

      if (!doneOutcome) {
        throw new ContentError(502, "MODEL_EMPTY_RESPONSE", "Model returned no response");
      }

      return doneOutcome;
    })().catch(async (error: unknown) => {
        const contentError =
          error instanceof ContentError ? error : toContentServiceError(error);
        await recordGatewayOperationEvent({
          teamId: prepared.workspace.organizationId,
          workspaceId: prepared.workspace.id,
          userId: prepared.userId,
          threadId: prepared.thread.id,
          messageId: prepared.userMessage.id,
          feature: "chat",
          operation: "chat.complete",
          modelKind: "chat",
          modelAlias: prepared.modelAlias,
          llm: input.llm,
          traceId: prepared.userMessage.id,
          success: false,
          errorCode: contentError.code,
          errorMessage: contentError.message,
          attributes: {
            retrievalCalls: summarizeRetrievalCalls([]),
          },
        });
        throw contentError;
      });

    const { assistantMessage, billing } = await this.finalizeThreadTurn({
      prepared,
      retrieval: outcome.retrieval,
      retrievalCalls: outcome.retrievalCalls,
      toolCalls: outcome.toolCalls,
      llm: input.llm,
      operation: "chat.complete",
      assistantContent: outcome.assistantContent,
      latencyMs: Date.now() - chatStartedAt,
      modelForMessage: prepared.modelAlias,
    });

    return {
      thread: prepared.thread,
      userMessage: prepared.userMessage,
      assistantMessage,
      billing,
      retrieval: {
        embeddingProfileId: outcome.retrieval.profile.id,
        vectorStrategy: outcome.retrieval.planner.strategy,
        annIndexUsed: outcome.retrieval.planner.annIndexUsed,
        citations: outcome.retrieval.retrievalSummary,
      },
    };
  }
}

export const contentService = new ContentService();
