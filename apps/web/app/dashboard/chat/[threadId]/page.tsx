"use client";

import {
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { useDashboardChatState } from "../../_components/dashboard-chat-state";
import {
  emptyModelCatalog,
  HeaderModelSelector,
  mapCatalogKindsToModelItems,
  resolveSelectedModels,
  type ModelAliasSettings,
  type ModelItem,
  type SelectedModels,
  type ModelType,
} from "../_components/header-model-selector";
import {
  ChatCanvas,
  DEFAULT_PROMPT_THINKING_SETTINGS,
  type ChatSkillItem,
  type CitationRecord,
  type MessageVersion,
  type ModelReasoningSegmentRecord,
  type PromptThinkingSettings,
  type ThinkingStepRecord,
  type ToolCallRecord,
  type VersionedMessageGroup,
} from "../_components/chat-canvas";
import {
  SourcesHub,
  type ThreadCitationRecord,
} from "../_components/sources-hub";
import { SourcePreviewPanel } from "../_components/source-preview-panel";
import {
  expandSelectedSources,
  type SourceItem,
} from "../_components/source-types";
import { contentClient } from "../../../../lib/sdk";
import { HttpClientError } from "@sourceweft/sdk";

const apiBaseUrl =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

const EMPTY_MODEL_KIND_FLAGS: Record<ModelType, boolean> = {
  llm: false,
  image: false,
  vision: false,
};
const EMPTY_CITATIONS: CitationRecord[] = [];
const SEARCH_PREFERENCE_STORAGE_VERSION = "v2";
const useBrowserLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

function getSearchPreferenceStorageKey(workspaceId: string) {
  return `chat:search:${SEARCH_PREFERENCE_STORAGE_VERSION}:${workspaceId}:current`;
}

type ThreadMessageItem = Awaited<
  ReturnType<typeof contentClient.listThreadMessages>
>["items"][number];

type ChatMessageItem = {
  id: string;
  role: "user" | "assistant";
  content: string;
  parentMessageId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

const STREAM_TEXT_PAUSED_KEY = "isTextPaused";
const STREAM_TEXT_INTERRUPTED_KEY = "isTextInterrupted";
const TITLE_POLL_INTERVAL_MS = 1000;
const TITLE_POLL_TIMEOUT_MS = 60000;
const THREAD_MESSAGES_LOAD_RETRY_DELAYS_MS = [300, 1000, 2500] as const;

type PendingLatestVersionSelection = {
  userGroupId?: string;
  assistantGroupId?: string;
};

type RequestThinkingConfig = {
  mode: "auto" | "off" | "effort";
  enabled?: boolean;
  effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  includeReasoning?: boolean;
};

function parseStoredThinkingSettings(
  value: string | null,
): PromptThinkingSettings | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as Partial<PromptThinkingSettings>;
    const mode = parsed.mode;
    const effort = parsed.effort;
    if (mode !== "auto" && mode !== "off" && mode !== "effort") {
      return null;
    }
    if (
      effort !== "minimal" &&
      effort !== "low" &&
      effort !== "medium" &&
      effort !== "high" &&
      effort !== "xhigh"
    ) {
      return null;
    }
    return { mode, effort };
  } catch {
    return null;
  }
}

function buildRequestThinking(input: {
  capabilities: ModelItem["capabilities"] | undefined;
  settings: PromptThinkingSettings;
}): RequestThinkingConfig | undefined {
  if (input.capabilities?.supportsThinking !== true) {
    return undefined;
  }

  if (input.settings.mode === "off") {
    return {
      mode: "off",
      enabled: false,
      includeReasoning: false,
    };
  }

  if (input.settings.mode === "effort") {
    if (
      !(input.capabilities?.supportedEfforts ?? []).includes(
        input.settings.effort,
      )
    ) {
      return {
        mode: "auto",
      };
    }

    return {
      mode: "effort",
      enabled: true,
      effort: input.settings.effort,
      includeReasoning: true,
    };
  }

  return {
    mode: "auto",
  };
}

function resolveClientTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
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

function normalizeThinkingSettingsForModel(input: {
  capabilities: ModelItem["capabilities"] | undefined;
  hasSavedPreference?: boolean;
  settings: PromptThinkingSettings;
}): PromptThinkingSettings {
  if (
    input.capabilities?.supportsThinking === true &&
    input.settings.mode === "off" &&
    input.hasSavedPreference !== true
  ) {
    return {
      ...input.settings,
      mode: "auto",
    };
  }

  if (input.settings.mode !== "effort") {
    return input.settings;
  }

  if (
    (input.capabilities?.supportedEfforts ?? []).includes(input.settings.effort)
  ) {
    return input.settings;
  }

  return {
    ...input.settings,
    mode: "auto",
  };
}

function getDisplayErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Failed to send message.";
}

function shouldRetryThreadMessagesLoad(error: unknown) {
  if (!(error instanceof HttpClientError)) {
    return true;
  }

  return error.status === 408 || error.status === 429 || error.status >= 500;
}

function waitForThreadMessagesRetry(delayMs: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, delayMs);
  });
}

function toObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function toNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function resolveCitationMetadata(metadata: Record<string, unknown>) {
  const retrieval = toObjectRecord(metadata.retrieval);
  return {
    citations: normalizeCitationRecords(retrieval?.citations),
    availableCitations: normalizeCitationRecords(retrieval?.availableCitations),
  };
}

function normalizeCitationRecords(value: unknown): CitationRecord[] {
  const rawCitations = value;
  if (!Array.isArray(rawCitations)) {
    return [] as CitationRecord[];
  }

  return rawCitations
    .map((item) => {
      const record = toObjectRecord(item);
      if (!record) {
        return null;
      }

      const citation = toNullableString(record.citation);
      const sourceId = toNullableString(record.sourceId);
      const documentId = toNullableString(record.documentId);
      const chunkId = toNullableString(record.chunkId);
      const sourceTitle = toNullableString(record.sourceTitle) ?? undefined;
      const chunkNo = toNullableNumber(record.chunkNo) ?? undefined;
      const score = toNullableNumber(record.score);
      const excerpt = toNullableString(record.excerpt);
      const content = toNullableString(record.content) ?? undefined;
      const externalUri = toNullableString(record.externalUri) ?? undefined;

      if (
        citation === null ||
        !chunkId ||
        score === null ||
        excerpt === null ||
        (!externalUri && (!sourceId || !documentId))
      ) {
        return null;
      }

      const citationRecord: CitationRecord = {
        citation,
        sourceId,
        documentId,
        chunkId,
        score,
        excerpt,
      };

      if (sourceTitle !== undefined) {
        citationRecord.sourceTitle = sourceTitle;
      }
      if (chunkNo !== undefined) {
        citationRecord.chunkNo = chunkNo;
      }
      if (externalUri !== undefined) {
        citationRecord.externalUri = externalUri;
      }
      if (content !== undefined) {
        citationRecord.content = content;
      }

      return citationRecord;
    })
    .filter((item): item is CitationRecord => item !== null);
}

function resolveMessageSourceIds(message: ChatMessageItem) {
  const rawSourceIds = message.metadata.sourceIds;
  if (!Array.isArray(rawSourceIds)) {
    return [] as string[];
  }

  return rawSourceIds.filter(
    (sourceId): sourceId is string => typeof sourceId === "string",
  );
}

function resolveMessageEffectiveSourceIds(message: ChatMessageItem) {
  const rawSourceIds = message.metadata.effectiveSourceIds;
  if (!Array.isArray(rawSourceIds)) {
    return undefined;
  }

  return rawSourceIds.filter(
    (sourceId): sourceId is string => typeof sourceId === "string",
  );
}

const CITATION_PATTERN =
  /[[【]\u200B?citation:\s*([\w:-]+(?:\s*,\s*[\w:-]+)*)\s*\u200B?[\]】]/g;

function splitCitationIds(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function resolveUsedCitationsForText(input: {
  citations: CitationRecord[] | undefined;
  text: string;
}) {
  const citationByKey = new Map(
    (input.citations ?? []).map((citation) => [citation.citation, citation]),
  );
  const citationByChunkId = new Map(
    (input.citations ?? []).map((citation) => [citation.chunkId, citation]),
  );
  const used: CitationRecord[] = [];
  const seen = new Set<string>();

  const pushCitation = (id: string) => {
    const citation = citationByKey.get(id) ?? citationByChunkId.get(id);
    if (!citation || seen.has(citation.chunkId)) {
      return;
    }
    seen.add(citation.chunkId);
    used.push(citation);
  };

  CITATION_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CITATION_PATTERN.exec(input.text)) !== null) {
    splitCitationIds(match[1] ?? "").forEach(pushCitation);
  }

  return used;
}

function resolveActiveAssistantVersion(input: {
  activeVersionByGroup: Record<string, number>;
  group: VersionedMessageGroup;
  groups: VersionedMessageGroup[];
}): MessageVersion | null {
  if (input.group.role !== "assistant") {
    return null;
  }

  const userGroup = input.group.turnId
    ? input.groups.find(
        (candidate) =>
          candidate.role === "user" && candidate.turnId === input.group.turnId,
      )
    : null;
  const selectedUserVersionId = userGroup
    ? (() => {
        const latestUserVersionIndex = Math.max(
          userGroup.versions.length - 1,
          0,
        );
        const activeUserBranchIndex = Math.min(
          Math.max(
            input.activeVersionByGroup[userGroup.groupId] ??
              latestUserVersionIndex,
            0,
          ),
          latestUserVersionIndex,
        );
        return userGroup.versions[activeUserBranchIndex]?.id ?? null;
      })()
    : null;

  const versionEntries = input.group.versions.map((version, originalIndex) => ({
    version,
    originalIndex,
  }));
  const scopedEntries = selectedUserVersionId
    ? versionEntries.filter(
        (entry) => entry.version.sourceUserMessageId === selectedUserVersionId,
      )
    : versionEntries;
  const visibleEntries =
    scopedEntries.length > 0 ? scopedEntries : versionEntries;
  const latestVisibleIndex = Math.max(visibleEntries.length - 1, 0);
  const desiredOriginalIndex =
    input.activeVersionByGroup[input.group.groupId] ??
    visibleEntries[latestVisibleIndex]?.originalIndex ??
    0;
  const matchedVisibleIndex = visibleEntries.findIndex(
    (entry) => entry.originalIndex === desiredOriginalIndex,
  );
  const activeVisibleIndex =
    matchedVisibleIndex >= 0 ? matchedVisibleIndex : latestVisibleIndex;

  return visibleEntries[activeVisibleIndex]?.version ?? null;
}

function resolveContextSourceIds(input: {
  messages: ChatMessageItem[];
  activeSourceIds: string[];
}) {
  if (input.activeSourceIds.length > 0) {
    return input.activeSourceIds;
  }

  const sourceIds: string[] = [];
  const seen = new Set<string>();
  for (const message of input.messages) {
    for (const sourceId of resolveMessageSourceIds(message)) {
      if (!seen.has(sourceId)) {
        seen.add(sourceId);
        sourceIds.push(sourceId);
      }
    }
  }
  return sourceIds;
}

function resolveRefreshSourceIds(input: {
  activeSourceIds?: string[];
  assistantMessageId: string;
  groups: VersionedMessageGroup[];
}) {
  const assistantVersion = input.groups
    .flatMap((group) => group.versions)
    .find((version) => version.id === input.assistantMessageId);
  const sourceUserMessageId = assistantVersion?.sourceUserMessageId;
  if (!sourceUserMessageId) {
    return [] as string[];
  }

  const userVersion = input.groups
    .filter((group) => group.role === "user")
    .flatMap((group) => group.versions)
    .find((version) => version.id === sourceUserMessageId);

  const sourceIds = userVersion?.sourceIds ?? [];
  if (sourceIds.length > 0) {
    return sourceIds;
  }

  return input.activeSourceIds ?? [];
}

function resolveEditSourceIds(input: {
  activeSourceIds: string[];
  editingMessageId: string;
  groups: VersionedMessageGroup[];
}) {
  if (input.activeSourceIds.length > 0) {
    return input.activeSourceIds;
  }

  const userVersion = input.groups
    .filter((group) => group.role === "user")
    .flatMap((group) => group.versions)
    .find((version) => version.id === input.editingMessageId);

  return userVersion?.sourceIds ?? [];
}

function normalizeToolCallStatus(
  value: unknown,
  fallback: ToolCallRecord["status"],
): ToolCallRecord["status"] {
  return value === "running" || value === "completed" || value === "error"
    ? value
    : fallback;
}

function normalizeToolCallRecord(
  value: unknown,
  options?: {
    defaultStatus?: ToolCallRecord["status"];
  },
): ToolCallRecord | null {
  const record = toObjectRecord(value);
  if (!record) {
    return null;
  }

  const id = typeof record.id === "string" ? record.id : null;
  const tool = typeof record.tool === "string" ? record.tool : null;
  if (!id || !tool) {
    return null;
  }

  const status = normalizeToolCallStatus(
    record.status,
    options?.defaultStatus ?? "completed",
  );

  return {
    id,
    tool,
    input: toObjectRecord(record.input) ?? {},
    output: normalizeToolOutput(record.output),
    latencyMs: toNullableNumber(record.latencyMs),
    status,
    error: toNullableString(record.error),
    sequence: toNullableNumber(record.sequence) ?? undefined,
  };
}

function normalizeToolOutput(value: unknown): unknown {
  const record = toObjectRecord(value);
  if (!record) {
    return value ?? null;
  }

  const kwargs = toObjectRecord(record.kwargs);
  if (Array.isArray(record.id) && record.id.includes("ToolMessage") && kwargs) {
    const content = Array.isArray(kwargs.content)
      ? kwargs.content
          .map((item) => {
            const itemRecord = toObjectRecord(item);
            if (itemRecord && typeof itemRecord.text === "string") {
              return itemRecord.text;
            }
            return typeof item === "string" ? item : null;
          })
          .filter((item): item is string => item !== null)
          .join("\n")
      : typeof kwargs.content === "string"
        ? kwargs.content
        : null;

    return {
      content,
      status: typeof kwargs.status === "string" ? kwargs.status : undefined,
      name: typeof kwargs.name === "string" ? kwargs.name : undefined,
    };
  }

  return value;
}

function normalizeThinkingStepRecord(
  value: unknown,
): ThinkingStepRecord | null {
  const record = toObjectRecord(value);
  if (!record) {
    return null;
  }

  const id = toNullableString(record.id);
  const title = toNullableString(record.title);
  const status = record.status;
  if (
    !id ||
    !title ||
    (status !== "pending" && status !== "in_progress" && status !== "completed")
  ) {
    return null;
  }

  const items = Array.isArray(record.items)
    ? record.items.filter((item): item is string => typeof item === "string")
    : [];

  return {
    id,
    kind:
      record.kind === "log" ||
      record.kind === "state" ||
      record.kind === "verification" ||
      record.kind === "reasoning_summary"
        ? record.kind
        : undefined,
    title,
    status,
    items,
    sequence: toNullableNumber(record.sequence) ?? undefined,
    description: toNullableString(record.description) ?? undefined,
    detail: toNullableString(record.detail) ?? undefined,
    metadata: toObjectRecord(record.metadata) ?? undefined,
  };
}

function resolveThinkingStepsFromMetadata(metadata: Record<string, unknown>) {
  if (!Array.isArray(metadata.thinkingSteps)) {
    return [] as ThinkingStepRecord[];
  }

  return metadata.thinkingSteps
    .map((item) => normalizeThinkingStepRecord(item))
    .filter((item): item is ThinkingStepRecord => item !== null);
}

function resolveModelReasoningFromMetadata(metadata: Record<string, unknown>) {
  const direct = toNullableString(metadata.reasoning);
  if (direct?.trim()) {
    return direct.trim();
  }

  return undefined;
}

function normalizeModelReasoningSegmentRecord(
  value: unknown,
  fallbackIndex = 0,
): ModelReasoningSegmentRecord | null {
  const record = toObjectRecord(value);
  if (!record) {
    return null;
  }

  const text = toNullableString(record.text)?.trim();
  if (!text) {
    return null;
  }

  return {
    id: toNullableString(record.id) ?? `model-reasoning-${fallbackIndex + 1}`,
    text,
    sequence: toNullableNumber(record.sequence) ?? undefined,
    durationMs: toNullableNumber(record.durationMs) ?? undefined,
  };
}

function resolveModelReasoningSegmentsFromMetadata(
  metadata: Record<string, unknown>,
) {
  if (!Array.isArray(metadata.reasoningSegments)) {
    return [] as ModelReasoningSegmentRecord[];
  }

  return metadata.reasoningSegments
    .map((item, index) => normalizeModelReasoningSegmentRecord(item, index))
    .filter((item): item is ModelReasoningSegmentRecord => item !== null);
}

function shouldRenderToolCall(
  toolCall: ToolCallRecord,
  thinkingSteps: ThinkingStepRecord[] = [],
) {
  void toolCall;
  void thinkingSteps;
  return true;
}

function mergeThinkingStepRecords(
  stepsById: Map<string, ThinkingStepRecord>,
  nextStep: ThinkingStepRecord,
) {
  const existing = stepsById.get(nextStep.id);
  if (!existing || nextStep.kind !== "log") {
    stepsById.set(nextStep.id, nextStep);
    return;
  }

  stepsById.set(nextStep.id, {
    ...existing,
    status: nextStep.status,
    description: nextStep.description ?? existing.description,
    detail: nextStep.detail ?? existing.detail,
    items: nextStep.items.length > 0 ? nextStep.items : existing.items,
    metadata: {
      ...(existing.metadata ?? {}),
      ...(nextStep.metadata ?? {}),
    },
  });
}

type ToolCallEventType =
  | "tool-call-start"
  | "tool-call-event"
  | "tool-call-result"
  | "tool-call-error"
  | "tool-call-end";

type StreamEventPayload = {
  type: string;
  code?: string;
  delta?: string;
  error?: string;
  id?: string;
  messageId?: string;
  parentMessageId?: string | null;
  tool?: string;
  userMessageId?: string;
  query?: string;
  hitCount?: number;
  latencyMs?: number;
  status?: string;
  data?: unknown;
  input?: unknown;
  output?: unknown;
  reasoning?: string;
  segment?: unknown;
  toolCall?: unknown;
  step?: unknown;
  citations?: unknown;
  availableCitations?: unknown;
  threadId?: string;
  title?: string;
  jobId?: string;
  sourceIds?: unknown;
  effectiveSourceIds?: unknown;
};

type JobStatusResponse = {
  status?: string;
  result?: unknown;
  data?: JobStatusResponse;
};

function resolveJobStatusPayload(payload: JobStatusResponse | null) {
  return payload?.data ?? payload;
}

function getTitleFromJobResult(value: unknown) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const result = value as Record<string, unknown>;
  return result.status === "applied" && typeof result.title === "string"
    ? result.title.trim()
    : null;
}

function isToolCallEventType(value: string): value is ToolCallEventType {
  return (
    value === "tool-call-start" ||
    value === "tool-call-event" ||
    value === "tool-call-result" ||
    value === "tool-call-error" ||
    value === "tool-call-end"
  );
}

function isToolCallEvent(
  value: StreamEventPayload,
): value is StreamEventPayload & { type: ToolCallEventType } {
  return isToolCallEventType(value.type);
}

function resolveToolCallFromStreamEvent(input: {
  event: StreamEventPayload & { type: ToolCallEventType };
  streamToolCallsById: Map<string, ToolCallRecord>;
}): ToolCallRecord {
  const normalizedToolCall = normalizeToolCallRecord(input.event.toolCall, {
    defaultStatus:
      input.event.type === "tool-call-error"
        ? "error"
        : input.event.type === "tool-call-result" ||
            input.event.type === "tool-call-end"
          ? "completed"
          : "running",
  });

  const fallbackId =
    typeof input.event.id === "string" && input.event.id.length > 0
      ? input.event.id
      : `tool-${input.streamToolCallsById.size + 1}`;
  const resolvedId = normalizedToolCall?.id ?? fallbackId;
  const existing =
    input.streamToolCallsById.get(resolvedId) ??
    input.streamToolCallsById.get(fallbackId);

  const tool =
    normalizedToolCall?.tool ??
    (typeof input.event.tool === "string" && input.event.tool.length > 0
      ? input.event.tool
      : (existing?.tool ?? "tool"));

  const eventInput = toObjectRecord(input.event.input);
  const normalizedInput = {
    ...(existing?.input ?? {}),
    ...(eventInput ?? {}),
    ...(normalizedToolCall?.input ?? {}),
    ...(typeof input.event.query === "string" &&
    input.event.query.trim().length > 0
      ? { query: input.event.query }
      : {}),
  };

  const eventOutput =
    input.event.type === "tool-call-event"
      ? (input.event.data ?? null)
      : input.event.type === "tool-call-result"
        ? input.event.output !== undefined
          ? input.event.output
          : null
        : null;
  const normalizedToolOutput = normalizedToolCall?.output;
  const mergedOutput = (() => {
    const existingOutput = toObjectRecord(existing?.output);
    const normalizedToolOutputRecord = toObjectRecord(normalizedToolOutput);
    const eventOutputRecord = toObjectRecord(eventOutput);
    if (
      existingOutput ||
      normalizedToolOutputRecord ||
      eventOutputRecord ||
      typeof input.event.hitCount === "number" ||
      typeof input.event.query === "string"
    ) {
      return {
        ...(existingOutput ?? {}),
        ...(eventOutputRecord ?? {}),
        ...(normalizedToolOutputRecord ?? {}),
        ...(typeof input.event.query === "string" &&
        input.event.query.trim().length > 0
          ? { query: input.event.query }
          : {}),
        ...(typeof input.event.hitCount === "number"
          ? { hitCount: input.event.hitCount }
          : {}),
      };
    }

    return normalizedToolOutput ?? eventOutput ?? existing?.output ?? null;
  })();
  const normalizedOutput = normalizeToolOutput(mergedOutput);

  const normalizedStatus = (() => {
    if (input.event.type === "tool-call-error") {
      return "error" as const;
    }

    if (input.event.type === "tool-call-result") {
      return "completed" as const;
    }

    if (input.event.type === "tool-call-end") {
      return normalizeToolCallStatus(
        input.event.status,
        existing?.status ?? "completed",
      );
    }

    if (normalizedToolCall) {
      return normalizedToolCall.status;
    }

    return normalizeToolCallStatus(input.event.status, "running");
  })();

  const normalizedLatencyMs =
    normalizedToolCall?.latencyMs ??
    toNullableNumber(input.event.latencyMs) ??
    existing?.latencyMs ??
    null;

  const normalizedError =
    normalizedToolCall?.error ??
    (input.event.type === "tool-call-error"
      ? (toNullableString(input.event.error) ?? "Tool execution failed.")
      : normalizedStatus === "error"
        ? (existing?.error ?? "Tool execution failed.")
        : null);

  return {
    id: resolvedId,
    tool,
    input: normalizedInput,
    output: normalizedOutput,
    latencyMs: normalizedLatencyMs,
    status: normalizedStatus,
    error: normalizedError,
  };
}

function resolveToolCallsFromMetadata(metadata: Record<string, unknown>) {
  if (!Array.isArray(metadata.toolCalls)) {
    return [] as ToolCallRecord[];
  }

  return metadata.toolCalls
    .map((item) => normalizeToolCallRecord(item))
    .filter((item): item is ToolCallRecord => item !== null)
    .filter((item) =>
      shouldRenderToolCall(item, resolveThinkingStepsFromMetadata(metadata)),
    );
}

function resolveAssistantSourceUserMessageId(
  message: ChatMessageItem,
  fallbackUserMessageId: string | null,
) {
  const candidate =
    message.metadata.userMessageId ??
    message.metadata.sourceUserMessageId ??
    message.metadata.promptMessageId;

  if (typeof candidate === "string" && candidate.length > 0) {
    return candidate;
  }

  return fallbackUserMessageId;
}

function buildVersionedMessageGroups(
  messages: ChatMessageItem[],
): VersionedMessageGroup[] {
  const sorted = [...messages].sort(
    (left, right) =>
      new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
  );
  const messageById = new Map(sorted.map((message) => [message.id, message]));
  const rootIdCache = new Map<string, string>();

  const resolveRootId = (message: ChatMessageItem) => {
    const cached = rootIdCache.get(message.id);
    if (cached) {
      return cached;
    }

    let current: ChatMessageItem | undefined = message;
    while (current?.parentMessageId) {
      const parent = messageById.get(current.parentMessageId);
      if (!parent) {
        break;
      }
      current = parent;
    }
    const rootId = current?.id ?? message.id;
    rootIdCache.set(message.id, rootId);
    return rootId;
  };

  const rootIdsInOrder: string[] = [];
  const seenRootIds = new Set<string>();
  for (const message of sorted) {
    const rootId = resolveRootId(message);
    if (seenRootIds.has(rootId)) {
      continue;
    }
    seenRootIds.add(rootId);
    rootIdsInOrder.push(rootId);
  }

  const turns: Array<{
    turnId: string;
    userRootId: string | null;
    assistantRootId: string | null;
    createdAt: string;
  }> = [];

  for (const rootId of rootIdsInOrder) {
    const rootMessage = messageById.get(rootId);
    if (!rootMessage) {
      continue;
    }

    if (rootMessage.role === "user") {
      turns.push({
        turnId: `turn:${rootMessage.id}`,
        userRootId: rootMessage.id,
        assistantRootId: null,
        createdAt: rootMessage.createdAt,
      });
      continue;
    }

    if (rootMessage.role !== "assistant") {
      continue;
    }

    const openTurn = [...turns].reverse().find((turn) => !turn.assistantRootId);
    if (openTurn) {
      openTurn.assistantRootId = rootMessage.id;
      continue;
    }

    const latestTurn = turns[turns.length - 1];
    if (latestTurn) {
      latestTurn.assistantRootId = rootMessage.id;
      continue;
    }

    turns.push({
      turnId: `turn:${rootMessage.id}`,
      userRootId: null,
      assistantRootId: rootMessage.id,
      createdAt: rootMessage.createdAt,
    });
  }

  const userRootToTurnId = new Map<string, string>();
  const assistantRootToTurnId = new Map<string, string>();
  const turnOrder = new Map<string, number>();
  turns.forEach((turn, index) => {
    turnOrder.set(turn.turnId, index);
    if (turn.userRootId) {
      userRootToTurnId.set(turn.userRootId, turn.turnId);
    }
    if (turn.assistantRootId) {
      assistantRootToTurnId.set(turn.assistantRootId, turn.turnId);
    }
  });

  const assistantSourceUserById = new Map<string, string | null>();
  let latestUserMessageId: string | null = null;
  for (const message of sorted) {
    if (message.role === "user") {
      latestUserMessageId = message.id;
      continue;
    }

    if (message.role === "assistant") {
      assistantSourceUserById.set(
        message.id,
        resolveAssistantSourceUserMessageId(message, latestUserMessageId),
      );
    }
  }

  const grouped = new Map<
    string,
    {
      turnId: string;
      role: "user" | "assistant";
      versions: ChatMessageItem[];
    }
  >();

  for (const message of sorted) {
    const rootId = resolveRootId(message);
    const turnId =
      message.role === "user"
        ? (userRootToTurnId.get(rootId) ?? `turn:${rootId}`)
        : (assistantRootToTurnId.get(rootId) ?? `turn:${rootId}`);
    const groupId = `${message.role}:${rootId}`;
    const existing = grouped.get(groupId);
    if (existing) {
      existing.versions.push(message);
    } else {
      grouped.set(groupId, {
        turnId,
        role: message.role,
        versions: [message],
      });
    }
  }

  return [...grouped.entries()]
    .map(([groupId, group]) => {
      const sortedVersions = [...group.versions].sort(
        (left, right) =>
          new Date(left.createdAt).getTime() -
          new Date(right.createdAt).getTime(),
      );
      const latestVersion =
        sortedVersions[sortedVersions.length - 1] ?? sortedVersions[0];

      return {
        groupId,
        turnId: group.turnId,
        latestVersionId: latestVersion?.id ?? groupId,
        role: group.role,
        versions: sortedVersions.map((version) => {
          const citationMetadata =
            group.role === "assistant"
              ? resolveCitationMetadata(version.metadata)
              : null;

          return {
            id: version.id,
            content: version.content,
            citations: citationMetadata?.citations,
            availableCitations: citationMetadata?.availableCitations,
            isError: version.metadata.isError === true,
            error: toNullableString(version.metadata.error),
            errorCode: toNullableString(version.metadata.errorCode),
            isTextPaused: version.metadata[STREAM_TEXT_PAUSED_KEY] === true,
            isTextInterrupted:
              version.metadata[STREAM_TEXT_INTERRUPTED_KEY] === true,
            sourceIds:
              group.role === "user"
                ? resolveMessageSourceIds(version)
                : undefined,
            effectiveSourceIds:
              group.role === "user"
                ? resolveMessageEffectiveSourceIds(version)
                : undefined,
            sourceAssistantMessageId:
              group.role === "assistant"
                ? (toNullableString(
                    version.metadata.sourceAssistantMessageId,
                  ) ?? null)
                : undefined,
            sourceUserMessageId:
              group.role === "assistant"
                ? (assistantSourceUserById.get(version.id) ?? null)
                : undefined,
            toolCalls: resolveToolCallsFromMetadata(version.metadata),
            thinkingSteps:
              group.role === "assistant"
                ? resolveThinkingStepsFromMetadata(version.metadata)
                : undefined,
            modelReasoning:
              group.role === "assistant"
                ? resolveModelReasoningFromMetadata(version.metadata)
                : undefined,
            modelReasoningSegments:
              group.role === "assistant"
                ? resolveModelReasoningSegmentsFromMetadata(version.metadata)
                : undefined,
          };
        }),
      } satisfies VersionedMessageGroup;
    })
    .sort((left, right) => {
      const leftTurnOrder =
        turnOrder.get(left.turnId ?? "") ?? Number.MAX_SAFE_INTEGER;
      const rightTurnOrder =
        turnOrder.get(right.turnId ?? "") ?? Number.MAX_SAFE_INTEGER;
      if (leftTurnOrder !== rightTurnOrder) {
        return leftTurnOrder - rightTurnOrder;
      }

      if (left.role !== right.role) {
        return left.role === "user" ? -1 : 1;
      }

      const leftFirst = grouped.get(left.groupId)?.versions[0];
      const rightFirst = grouped.get(right.groupId)?.versions[0];
      return (
        new Date(leftFirst?.createdAt ?? 0).getTime() -
        new Date(rightFirst?.createdAt ?? 0).getTime()
      );
    });
}

export default function DashboardChatThreadPage({
  params,
}: {
  params: Promise<{ threadId: string }>;
}) {
  const { threadId } = use(params);

  const {
    privateChats,
    sourcesVisible,
    toggleSourcesVisible,
    updateChatTitle,
    updateChatSourceCount,
    workspaceId,
  } = useDashboardChatState();

  // ── Thread metadata from sidebar list ─────────────────────────────────────
  const chatItem = privateChats.find((c) => c.id === threadId);
  const threadTitle = chatItem?.title ?? "Chat";

  // ── Messaging state ────────────────────────────────────────────────────────
  const [messages, setMessages] = useState<ChatMessageItem[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingAssistantMessageId, setEditingAssistantMessageId] = useState<
    string | null
  >(null);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingBranchIndex, setEditingBranchIndex] = useState<number | null>(
    null,
  );
  const [activeVersionByGroup, setActiveVersionByGroup] = useState<
    Record<string, number>
  >({});
  const [activeCitationIndex, setActiveCitationIndex] = useState<number | null>(
    null,
  );
  const [previewCitation, setPreviewCitation] = useState<CitationRecord | null>(
    null,
  );
  const [displayedCitations, setDisplayedCitations] = useState<
    CitationRecord[]
  >([]);
  const [highlightedMessageId, setHighlightedMessageId] = useState<
    string | null
  >(null);
  const latestSignatureByGroupRef = useRef<Record<string, string>>({});
  const loadedThreadMessagesKeyRef = useRef<string | null>(null);
  const threadMessagesLoadGenerationRef = useRef(0);
  const pendingLatestVersionSelectionRef =
    useRef<PendingLatestVersionSelection | null>(null);

  // ── Sources state ──────────────────────────────────────────────────────────
  const [librarySources, setLibrarySources] = useState<SourceItem[]>([]);
  const [activeSourceIds, setActiveSourceIds] = useState<string[]>([]);
  const [availableSkills, setAvailableSkills] = useState<ChatSkillItem[]>([]);
  const [activeSkillIds, setActiveSkillIds] = useState<string[]>([]);
  const [selectionLoaded, setSelectionLoaded] = useState(false);

  // ── Composer state ─────────────────────────────────────────────────────────
  const [composerInitialInput, setComposerInitialInput] = useState("");
  const [composerResetKey, setComposerResetKey] = useState(0);
  const [selectedModels, setSelectedModels] = useState<SelectedModels>(() =>
    resolveSelectedModels({ availableModels: emptyModelCatalog }),
  );
  const [availableModels, setAvailableModels] =
    useState<Record<ModelType, ModelItem[]>>(emptyModelCatalog);
  const [catalogKindEnabled, setCatalogKindEnabled] = useState<
    Record<ModelType, boolean>
  >(EMPTY_MODEL_KIND_FLAGS);
  const [streamWithSelectedLlm, setStreamWithSelectedLlm] = useState(false);
  const [thinkingSettings, setThinkingSettings] =
    useState<PromptThinkingSettings>(DEFAULT_PROMPT_THINKING_SETTINGS);
  const [hasSavedThinkingPreference, setHasSavedThinkingPreference] =
    useState(false);
  const [searchEnabled, setSearchEnabled] = useState(true);
  const [loadedSearchPreferenceKey, setLoadedSearchPreferenceKey] = useState<
    string | null
  >(null);

  const clearEditingState = useCallback(() => {
    setEditingMessageId(null);
    setEditingAssistantMessageId(null);
    setEditingGroupId(null);
    setEditingBranchIndex(null);
  }, []);

  const cancelEditing = useCallback(() => {
    clearEditingState();
    setComposerInitialInput("");
    setComposerResetKey((value) => value + 1);
  }, [clearEditingState]);

  useEffect(() => {
    setThinkingSettings((current) =>
      normalizeThinkingSettingsForModel({
        capabilities: selectedModels.llm?.capabilities,
        hasSavedPreference: hasSavedThinkingPreference,
        settings: current,
      }),
    );
  }, [hasSavedThinkingPreference, selectedModels.llm]);

  // Tracks whether initial bootstrap was already processed for this thread key.
  const bootstrappedThreadKeyRef = useRef<string | null>(null);

  // ── Session storage: persist selected source IDs per thread ───────────────
  const selectionStorageKey = useMemo(
    () => (workspaceId ? `chat:sources:${workspaceId}:${threadId}` : null),
    [workspaceId, threadId],
  );
  const currentSelectionStorageKey = useMemo(
    () => (workspaceId ? `chat:sources:${workspaceId}:current` : null),
    [workspaceId],
  );
  const currentThinkingStorageKey = useMemo(
    () => (workspaceId ? `chat:thinking:${workspaceId}:current` : null),
    [workspaceId],
  );
  const currentSearchStorageKey = useMemo(
    () => (workspaceId ? getSearchPreferenceStorageKey(workspaceId) : null),
    [workspaceId],
  );

  useEffect(() => {
    setSelectionLoaded(false);
    if (!selectionStorageKey) {
      setActiveSourceIds([]);
      setSelectionLoaded(true);
      return;
    }
    const raw = window.sessionStorage.getItem(selectionStorageKey);
    if (!raw) {
      setActiveSourceIds([]);
      setSelectionLoaded(true);
      return;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        setActiveSourceIds(
          parsed.filter((item): item is string => typeof item === "string"),
        );
      } else {
        setActiveSourceIds([]);
      }
    } catch {
      setActiveSourceIds([]);
    } finally {
      setSelectionLoaded(true);
    }
  }, [selectionStorageKey]);

  const persistActiveSourceIds = useCallback(
    (sourceIds: string[]) => {
      setActiveSourceIds(sourceIds);
      if (selectionStorageKey) {
        window.sessionStorage.setItem(
          selectionStorageKey,
          JSON.stringify(sourceIds),
        );
      }
      if (currentSelectionStorageKey) {
        window.sessionStorage.setItem(
          currentSelectionStorageKey,
          JSON.stringify(sourceIds),
        );
      }
    },
    [currentSelectionStorageKey, selectionStorageKey],
  );

  useEffect(() => {
    if (!selectionLoaded || !selectionStorageKey) return;
    window.sessionStorage.setItem(
      selectionStorageKey,
      JSON.stringify(activeSourceIds),
    );
    if (currentSelectionStorageKey) {
      window.sessionStorage.setItem(
        currentSelectionStorageKey,
        JSON.stringify(activeSourceIds),
      );
    }
  }, [
    activeSourceIds,
    currentSelectionStorageKey,
    selectionLoaded,
    selectionStorageKey,
  ]);

  useEffect(() => {
    if (!currentThinkingStorageKey) {
      setThinkingSettings(DEFAULT_PROMPT_THINKING_SETTINGS);
      return;
    }

    const storedThinking = parseStoredThinkingSettings(
      window.sessionStorage.getItem(currentThinkingStorageKey),
    );
    setHasSavedThinkingPreference(Boolean(storedThinking));
    setThinkingSettings(storedThinking ?? DEFAULT_PROMPT_THINKING_SETTINGS);
  }, [currentThinkingStorageKey]);

  const handleThinkingSettingsChange = useCallback(
    (settings: PromptThinkingSettings) => {
      setHasSavedThinkingPreference(true);
      setThinkingSettings(settings);
    },
    [],
  );

  useEffect(() => {
    if (!currentSearchStorageKey) {
      setSearchEnabled(true);
      setLoadedSearchPreferenceKey(null);
      return;
    }

    const stored = window.sessionStorage.getItem(currentSearchStorageKey);
    setSearchEnabled(stored === null ? true : stored === "true");
    setLoadedSearchPreferenceKey(currentSearchStorageKey);
  }, [currentSearchStorageKey]);

  useEffect(() => {
    if (!currentThinkingStorageKey) {
      return;
    }
    window.sessionStorage.setItem(
      currentThinkingStorageKey,
      JSON.stringify(thinkingSettings),
    );
  }, [currentThinkingStorageKey, thinkingSettings]);

  useEffect(() => {
    if (
      !currentSearchStorageKey ||
      loadedSearchPreferenceKey !== currentSearchStorageKey
    ) {
      return;
    }
    window.sessionStorage.setItem(
      currentSearchStorageKey,
      searchEnabled ? "true" : "false",
    );
  }, [currentSearchStorageKey, loadedSearchPreferenceKey, searchEnabled]);

  useEffect(() => {
    if (!workspaceId) {
      setAvailableSkills([]);
      setActiveSkillIds([]);
      return;
    }

    let cancelled = false;
    const activeWorkspaceId = workspaceId;
    async function loadSkills() {
      try {
        const result = await contentClient.listSkillsCatalog(activeWorkspaceId);
        if (cancelled) {
          return;
        }
        const enabledSkills = result.items
          .filter((skill) => skill.enabled && skill.enabledWorkspaceSkillId)
          .map((skill) => ({
            id: skill.enabledWorkspaceSkillId as string,
            catalogId: skill.catalogId,
            slug: skill.slug,
            name: skill.name,
            displayName: skill.displayName,
            description: skill.description,
            sourceType: skill.sourceType,
            version: skill.version,
            hasReadme: skill.hasReadme,
          }));
        setAvailableSkills(enabledSkills);

        const enabledIds = new Set(enabledSkills.map((skill) => skill.id));
        setActiveSkillIds((current) =>
          current.filter((id) => enabledIds.has(id)).slice(0, 5),
        );
      } catch {
        if (!cancelled) {
          setAvailableSkills([]);
          setActiveSkillIds([]);
        }
      }
    }

    void loadSkills();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const messageGroups = useMemo(
    () => buildVersionedMessageGroups(messages),
    [messages],
  );

  const activeAssistantVersion = useMemo(() => {
    for (
      let groupIndex = messageGroups.length - 1;
      groupIndex >= 0;
      groupIndex -= 1
    ) {
      const group = messageGroups[groupIndex];
      if (!group || group.role !== "assistant") {
        continue;
      }

      return resolveActiveAssistantVersion({
        activeVersionByGroup,
        group,
        groups: messageGroups,
      });
    }

    return null;
  }, [activeVersionByGroup, messageGroups]);

  const activeCitations = useMemo(
    () =>
      resolveUsedCitationsForText({
        citations: activeAssistantVersion?.citations,
        text: activeAssistantVersion?.content ?? "",
      }),
    [activeAssistantVersion],
  );
  const activeAssistantCitations =
    activeAssistantVersion?.citations ?? EMPTY_CITATIONS;
  const activeAvailableCitations =
    activeAssistantVersion?.availableCitations ?? EMPTY_CITATIONS;
  const visibleCitations = useMemo(() => {
    if (activeCitations.length > 0) {
      return activeCitations;
    }
    if (activeAssistantCitations.length > 0) {
      return activeAssistantCitations;
    }
    return activeAvailableCitations;
  }, [activeAssistantCitations, activeAvailableCitations, activeCitations]);
  const threadCitations = useMemo<ThreadCitationRecord[]>(() => {
    const citationsByAnswer: ThreadCitationRecord[][] = [];
    let answerIndex = 0;

    for (const group of messageGroups) {
      if (group.role !== "assistant") {
        continue;
      }

      const version = resolveActiveAssistantVersion({
        activeVersionByGroup,
        group,
        groups: messageGroups,
      });
      if (!version) {
        continue;
      }

      answerIndex += 1;
      const usedCitations = resolveUsedCitationsForText({
        citations: version.citations,
        text: version.content,
      });
      const answerCitations =
        usedCitations.length > 0
          ? usedCitations
          : ((version.citations?.length
              ? version.citations
              : version.availableCitations) ?? EMPTY_CITATIONS);

      if (answerCitations.length === 0) {
        continue;
      }

      citationsByAnswer.push(
        answerCitations.map((citation, citationIndex) => ({
          citation,
          id: `${version.id}:${citation.chunkId}:${citationIndex}`,
          messageId: version.id,
          messageLabel: `Answer ${answerIndex}`,
        })),
      );
    }

    return citationsByAnswer.reverse().flat();
  }, [activeVersionByGroup, messageGroups]);

  useEffect(() => {
    if (!isStreaming || visibleCitations.length > 0) {
      setDisplayedCitations((current) => {
        if (
          current.length === visibleCitations.length &&
          current.every(
            (citation, index) =>
              citation.chunkId === visibleCitations[index]?.chunkId,
          )
        ) {
          return current;
        }
        return visibleCitations;
      });
    }
  }, [isStreaming, visibleCitations]);

  const handleCitationClick = useCallback(
    (citation: CitationRecord) => {
      const citationIndex = displayedCitations.findIndex(
        (item) => item.chunkId === citation.chunkId,
      );
      setActiveCitationIndex(citationIndex >= 0 ? citationIndex + 1 : null);
      setPreviewCitation(citation);
      if (!sourcesVisible) {
        toggleSourcesVisible();
      }
    },
    [displayedCitations, sourcesVisible, toggleSourcesVisible],
  );

  const scrollToMessage = useCallback((messageId: string) => {
    const selector = `[data-chat-message-id="${CSS.escape(messageId)}"]`;
    setHighlightedMessageId(messageId);

    const scroll = () => {
      const target = document.querySelector(selector) as HTMLElement | null;
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
    };

    window.requestAnimationFrame(scroll);
    window.setTimeout(scroll, 120);
    window.setTimeout(() => {
      setHighlightedMessageId((current) =>
        current === messageId ? null : current,
      );
    }, 1600);
  }, []);

  const handleSourceHubCitationOpen = useCallback(
    (citation: CitationRecord, context?: { messageId?: string }) => {
      setPreviewCitation(citation);
      if (context?.messageId) {
        scrollToMessage(context.messageId);
      }
    },
    [scrollToMessage],
  );

  useEffect(() => {
    setActiveCitationIndex(null);
    setPreviewCitation(null);
  }, [activeAssistantVersion?.id]);

  useEffect(() => {
    setActiveVersionByGroup((previous) => {
      const next: Record<string, number> = {};
      const nextSignatures: Record<string, string> = {};
      const pendingSelection = pendingLatestVersionSelectionRef.current;
      const appliedPendingGroups = new Set<string>();

      for (const group of messageGroups) {
        const maxIndex = Math.max(group.versions.length - 1, 0);
        const signature = `${group.groupId}:${group.latestVersionId}`;
        nextSignatures[group.groupId] = signature;

        if (
          group.groupId === pendingSelection?.userGroupId ||
          group.groupId === pendingSelection?.assistantGroupId
        ) {
          next[group.groupId] = maxIndex;
          appliedPendingGroups.add(group.groupId);
          continue;
        }

        const hasNewVersion =
          latestSignatureByGroupRef.current[group.groupId] !== signature;

        if (hasNewVersion) {
          next[group.groupId] = maxIndex;
          continue;
        }

        const previousIndex = previous[group.groupId];
        if (typeof previousIndex !== "number") {
          next[group.groupId] = maxIndex;
          continue;
        }

        next[group.groupId] = Math.min(Math.max(previousIndex, 0), maxIndex);
      }

      if (
        pendingSelection &&
        (!pendingSelection.userGroupId ||
          appliedPendingGroups.has(pendingSelection.userGroupId)) &&
        (!pendingSelection.assistantGroupId ||
          appliedPendingGroups.has(pendingSelection.assistantGroupId))
      ) {
        pendingLatestVersionSelectionRef.current = null;
      }

      latestSignatureByGroupRef.current = nextSignatures;
      return next;
    });
  }, [messageGroups]);

  const loadThreadMessages = useCallback(async () => {
    const loadGeneration = threadMessagesLoadGenerationRef.current + 1;
    threadMessagesLoadGenerationRef.current = loadGeneration;

    if (!workspaceId) {
      loadedThreadMessagesKeyRef.current = null;
      setMessages([]);
      return;
    }

    const threadMessagesKey = `${workspaceId}:${threadId}`;

    for (
      let attempt = 0;
      attempt <= THREAD_MESSAGES_LOAD_RETRY_DELAYS_MS.length;
      attempt += 1
    ) {
      try {
        const result = await contentClient.listThreadMessages(
          workspaceId,
          threadId,
        );
        const serverMessages = result.items
          .filter(
            (
              message,
            ): message is ThreadMessageItem & {
              role: "user" | "assistant";
            } => message.role === "user" || message.role === "assistant",
          )
          .map((message) => ({
            id: message.id,
            role: message.role,
            content: message.content,
            parentMessageId: message.parentMessageId,
            metadata: message.metadata,
            createdAt: message.createdAt,
          }))
          .sort(
            (left, right) =>
              new Date(left.createdAt).getTime() -
              new Date(right.createdAt).getTime(),
          );

        if (threadMessagesLoadGenerationRef.current !== loadGeneration) {
          return;
        }

        loadedThreadMessagesKeyRef.current = threadMessagesKey;
        setMessages(serverMessages);
        return;
      } catch (error) {
        if (threadMessagesLoadGenerationRef.current !== loadGeneration) {
          return;
        }

        const retryDelay = THREAD_MESSAGES_LOAD_RETRY_DELAYS_MS[attempt];
        if (
          retryDelay === undefined ||
          !shouldRetryThreadMessagesLoad(error)
        ) {
          if (loadedThreadMessagesKeyRef.current !== threadMessagesKey) {
            setMessages([]);
          }
          return;
        }

        await waitForThreadMessagesRetry(retryDelay);
        if (threadMessagesLoadGenerationRef.current !== loadGeneration) {
          return;
        }
      }
    }
  }, [threadId, workspaceId]);

  const loadThreadModelState = useCallback(async () => {
    if (!workspaceId) {
      setAvailableModels(emptyModelCatalog);
      setSelectedModels(
        resolveSelectedModels({ availableModels: emptyModelCatalog }),
      );
      setCatalogKindEnabled(EMPTY_MODEL_KIND_FLAGS);
      setStreamWithSelectedLlm(false);
      return;
    }

    setStreamWithSelectedLlm(false);

    try {
      const [catalog, threadResponse] = await Promise.all([
        contentClient.listThreadModelCatalog(workspaceId),
        contentClient.getThread(workspaceId, threadId),
      ]);

      const catalogModels = mapCatalogKindsToModelItems(catalog.kinds);
      const kindEnabled = {
        llm: catalogModels.llm.length > 0,
        image: catalogModels.image.length > 0,
        vision: catalogModels.vision.length > 0,
      } satisfies Record<ModelType, boolean>;

      setCatalogKindEnabled(kindEnabled);
      setAvailableModels(catalogModels);
      setSelectedModels(
        resolveSelectedModels({
          availableModels: catalogModels,
          threadAliases: threadResponse.thread.modelSettings,
          fallbackAliases: catalog.defaults,
        }),
      );
      setStreamWithSelectedLlm(kindEnabled.llm);
    } catch {
      setCatalogKindEnabled(EMPTY_MODEL_KIND_FLAGS);
      setAvailableModels(emptyModelCatalog);
      setSelectedModels(
        resolveSelectedModels({ availableModels: emptyModelCatalog }),
      );
      setStreamWithSelectedLlm(false);
    }
  }, [threadId, workspaceId]);

  useEffect(() => {
    void loadThreadModelState();
  }, [loadThreadModelState]);

  const handleModelSelect = useCallback(
    async (input: { type: ModelType; model: ModelItem }) => {
      if (!workspaceId || !catalogKindEnabled[input.type]) {
        return;
      }

      const patch: ModelAliasSettings =
        input.type === "llm"
          ? { llmProfileAlias: input.model.id }
          : input.type === "image"
            ? { imageProfileAlias: input.model.id }
            : { visionProfileAlias: input.model.id };

      try {
        await contentClient.updateThreadModelSettings(
          workspaceId,
          threadId,
          patch,
        );
        if (input.type === "llm") {
          setThinkingSettings((current) =>
            normalizeThinkingSettingsForModel({
              capabilities: input.model.capabilities,
              hasSavedPreference: hasSavedThinkingPreference,
              settings: current,
            }),
          );
          setStreamWithSelectedLlm(true);
        }
      } catch (error) {
        if (error instanceof HttpClientError) {
          const detailMessage =
            typeof error.details?.message === "string"
              ? error.details.message
              : undefined;
          const message = detailMessage || error.message || error.code;
          toast.error(`Failed to update model for this thread: ${message}`);
        } else {
          toast.error("Failed to update model for this thread.");
        }
        await loadThreadModelState();
      }
    },
    [
      catalogKindEnabled,
      hasSavedThinkingPreference,
      loadThreadModelState,
      threadId,
      workspaceId,
    ],
  );

  const streamThreadAction = useCallback(
    async (input: {
      mode: "send" | "refresh" | "edit";
      content?: string;
      sourceIds: string[];
      skillIds?: string[];
      userMessageId?: string | null;
      assistantMessageId?: string | null;
      thinking?: RequestThinkingConfig;
      searchEnabled?: boolean;
    }) => {
      if (!workspaceId) {
        return;
      }

      setIsStreaming(true);
      clearEditingState();

      const now = Date.now();
      const latestUserMessage = [...messages]
        .reverse()
        .find((message) => message.role === "user");
      const latestAssistantMessage = [...messages]
        .reverse()
        .find((message) => message.role === "assistant");

      const temporaryMessages: ChatMessageItem[] = [];
      let tempUserId: string | null = null;

      if (input.mode === "send" || input.mode === "edit") {
        tempUserId = `temp-user-${now}`;
        const localEffectiveSourceIds = expandSelectedSources(
          librarySources,
          input.sourceIds,
        ).map((source) => source.id);
        temporaryMessages.push({
          id: tempUserId,
          role: "user",
          content: input.content ?? "",
          parentMessageId:
            input.mode === "edit"
              ? (input.userMessageId ?? latestUserMessage?.id ?? null)
              : null,
          metadata: {
            sourceIds: input.sourceIds,
            ...(localEffectiveSourceIds.length > 0
              ? { effectiveSourceIds: localEffectiveSourceIds }
              : {}),
            skillIds: input.skillIds ?? [],
            tools: {
              skillIds: input.skillIds ?? [],
              webSearchEnabled: input.searchEnabled ?? searchEnabled,
            },
            versionOf:
              input.mode === "edit"
                ? (input.userMessageId ?? latestUserMessage?.id ?? null)
                : null,
          },
          createdAt: new Date(now).toISOString(),
        });
      }

      const tempAssistantId = `temp-assistant-${now + 1}`;
      temporaryMessages.push({
        id: tempAssistantId,
        role: "assistant",
        content: "",
        parentMessageId:
          input.mode === "send"
            ? null
            : (input.assistantMessageId ?? latestAssistantMessage?.id ?? null),
        metadata: {
          userMessageId:
            tempUserId ?? input.userMessageId ?? latestUserMessage?.id ?? null,
          versionOf:
            input.mode === "send"
              ? null
              : (input.assistantMessageId ??
                latestAssistantMessage?.id ??
                null),
          toolCalls: [],
          thinkingSteps: [],
        },
        createdAt: new Date(now + 1).toISOString(),
      });

      setMessages((previous) => [...previous, ...temporaryMessages]);

      if (input.mode !== "refresh") {
        setComposerInitialInput("");
        setComposerResetKey((value) => value + 1);
      }

      let persistedUserMessageId = tempUserId ?? input.userMessageId ?? null;
      let createdUserMessageId: string | null = tempUserId;
      let persistedAssistantMessageId: string | null = null;
      let shouldPollThreadTitle = false;
      let pendingTitleJobId: string | null = null;
      const streamToolCallsById = new Map<string, ToolCallRecord>();
      const streamThinkingStepsById = new Map<string, ThinkingStepRecord>();
      let streamingAssistantMessageId = tempAssistantId;
      let preparedEffectiveSourceIds: string[] | null = null;

      try {
        const requestBody: Record<string, unknown> = {
          mode: input.mode,
          sourceIds: input.sourceIds,
          timezone: resolveClientTimezone(),
        };
        const selectedSkillIds = input.skillIds ?? [];
        requestBody.tools = {
          skillIds: selectedSkillIds,
          webSearchEnabled: input.searchEnabled ?? searchEnabled,
        };
        const selectedLlmProfileAlias =
          streamWithSelectedLlm && catalogKindEnabled.llm
            ? selectedModels.llm?.id
            : undefined;
        const requestThinking =
          input.thinking ??
          buildRequestThinking({
            capabilities: selectedModels.llm?.capabilities,
            settings: thinkingSettings,
          });
        if (
          typeof selectedLlmProfileAlias === "string" &&
          selectedLlmProfileAlias.length > 0
        ) {
          requestBody.llm = {
            profileAlias: selectedLlmProfileAlias,
            ...(requestThinking ? { thinking: requestThinking } : {}),
          };
        } else if (requestThinking) {
          requestBody.llm = {
            thinking: requestThinking,
          };
        }
        if (input.mode === "send" || input.mode === "edit") {
          requestBody.content = input.content ?? "";
        }
        if (input.mode === "refresh" || input.mode === "edit") {
          if (input.userMessageId) {
            requestBody.userMessageId = input.userMessageId;
          }
          if (input.assistantMessageId) {
            requestBody.assistantMessageId = input.assistantMessageId;
          }
        }

        const response = await fetch(
          `${apiBaseUrl}/v1/workspaces/${workspaceId}/threads/${threadId}/stream`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify(requestBody),
          },
        );

        if (!response.ok) {
          throw new Error(`Server error: ${response.status}`);
        }

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error("No response body");
        }

        const decoder = new TextDecoder();
        let buffer = "";
        let assistantText = "";
        let streamError: Error | null = null;
        let hasRenderedDelta = false;
        const deltaQueue: string[] = [];
        let streamEnded = false;
        let drainPromise: Promise<void> | null = null;

        const pollThreadTitleJob = async (jobId: string) => {
          const startedAt = Date.now();
          while (Date.now() - startedAt < TITLE_POLL_TIMEOUT_MS) {
            await new Promise((resolve) =>
              window.setTimeout(resolve, TITLE_POLL_INTERVAL_MS),
            );
            const response = await fetch(
              `${apiBaseUrl}/v1/workspaces/${workspaceId}/threads/${threadId}/title-job/${encodeURIComponent(jobId)}`,
              { credentials: "include" },
            ).catch(() => null);
            if (!response?.ok) {
              continue;
            }

            const payload = (await response
              .json()
              .catch(() => null)) as JobStatusResponse | null;
            const jobStatus = resolveJobStatusPayload(payload);
            const status = jobStatus?.status;
            const title = getTitleFromJobResult(jobStatus?.result);
            if (title) {
              updateChatTitle(threadId, title);
              return;
            }
            if (status === "failed" || status === "cancelled") {
              return;
            }
          }
        };

        const waitForAnimationFrame = () =>
          new Promise<void>((resolve) => {
            window.requestAnimationFrame(() => resolve());
          });

        const startDeltaDrain = () => {
          if (drainPromise) {
            return;
          }

          drainPromise = (async () => {
            while (!streamEnded || deltaQueue.length > 0) {
              if (deltaQueue.length === 0) {
                await waitForAnimationFrame();
                continue;
              }

              const nextDelta = deltaQueue.shift();
              if (!nextDelta) {
                continue;
              }

              assistantText += nextDelta;
              flushSync(() => {
                setMessages((previous) =>
                  previous.map((message) =>
                    message.id === streamingAssistantMessageId
                      ? { ...message, content: assistantText }
                      : message,
                  ),
                );
              });

              if (!hasRenderedDelta && assistantText.length > 0) {
                hasRenderedDelta = true;
              }

              await waitForAnimationFrame();
            }
          })();
        };

        const enqueueDelta = (delta: string) => {
          if (!delta) {
            return;
          }

          const maxChunkSize = 24;
          const chars = Array.from(delta);
          if (chars.length <= maxChunkSize) {
            deltaQueue.push(delta);
            return;
          }

          for (let index = 0; index < chars.length; index += maxChunkSize) {
            deltaQueue.push(chars.slice(index, index + maxChunkSize).join(""));
          }
        };

        const syncStreamingToolCalls = () => {
          const thinkingSteps = [...streamThinkingStepsById.values()];
          const toolCalls = [...streamToolCallsById.values()].filter(
            (toolCall) => shouldRenderToolCall(toolCall, thinkingSteps),
          );
          const shouldShowTextPause =
            assistantText.length > 0 &&
            toolCalls.some((toolCall) => toolCall.status === "running");
          flushSync(() => {
            setMessages((previous) =>
              previous.map((message) =>
                message.id === streamingAssistantMessageId
                  ? {
                      ...message,
                      metadata: {
                        ...message.metadata,
                        [STREAM_TEXT_PAUSED_KEY]: shouldShowTextPause,
                        toolCalls,
                      },
                    }
                  : message,
              ),
            );
          });
        };

        const syncStreamingThinkingSteps = () => {
          const thinkingSteps = [...streamThinkingStepsById.values()];
          const toolCalls = [...streamToolCallsById.values()].filter(
            (toolCall) => shouldRenderToolCall(toolCall, thinkingSteps),
          );
          const shouldShowTextPause =
            assistantText.length > 0 &&
            (toolCalls.some((toolCall) => toolCall.status === "running") ||
              thinkingSteps.some((step) => step.status === "in_progress"));
          flushSync(() => {
            setMessages((previous) =>
              previous.map((message) =>
                message.id === streamingAssistantMessageId
                  ? {
                      ...message,
                      metadata: {
                        ...message.metadata,
                        [STREAM_TEXT_PAUSED_KEY]: shouldShowTextPause,
                        thinkingSteps,
                        toolCalls,
                      },
                    }
                  : message,
              ),
            );
          });
        };

        const syncStreamingCitations = (input: {
          citations: CitationRecord[];
          availableCitations?: CitationRecord[];
        }) => {
          flushSync(() => {
            setMessages((previous) =>
              previous.map((message) =>
                message.id === streamingAssistantMessageId
                  ? {
                      ...message,
                      metadata: {
                        ...message.metadata,
                        retrieval: {
                          ...(toObjectRecord(message.metadata.retrieval) ?? {}),
                          citations: input.citations,
                          availableCitations:
                            input.availableCitations ?? input.citations,
                        },
                      },
                    }
                  : message,
              ),
            );
          });
        };

        readLoop: while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() ?? "";

          for (const event of events) {
            const line = event.trim();
            if (!line.startsWith("data: ")) {
              continue;
            }

            let data: StreamEventPayload;
            try {
              data = JSON.parse(line.slice(6)) as typeof data;
            } catch {
              continue;
            }

            if (data.type === "start" && typeof data.messageId === "string") {
              const previousUserMessageId = tempUserId;
              const serverUserMessageId = data.messageId;
              const serverSourceIds = Array.isArray(data.sourceIds)
                ? data.sourceIds.filter(
                    (sourceId): sourceId is string =>
                      typeof sourceId === "string",
                  )
                : null;
              const serverEffectiveSourceIds = Array.isArray(
                data.effectiveSourceIds,
              )
                ? data.effectiveSourceIds.filter(
                    (sourceId): sourceId is string =>
                      typeof sourceId === "string",
                  )
                : null;
              preparedEffectiveSourceIds = serverEffectiveSourceIds;
              persistedUserMessageId = serverUserMessageId;
              if (tempUserId && createdUserMessageId === tempUserId) {
                createdUserMessageId = serverUserMessageId;
              }
              flushSync(() => {
                setMessages((previous) =>
                  previous.map((message) =>
                    previousUserMessageId &&
                    message.id === previousUserMessageId
                      ? {
                          ...message,
                          id: serverUserMessageId,
                          metadata: {
                            ...message.metadata,
                            ...(serverSourceIds
                              ? { sourceIds: serverSourceIds }
                              : {}),
                            ...(serverEffectiveSourceIds
                              ? { effectiveSourceIds: serverEffectiveSourceIds }
                              : {}),
                          },
                        }
                      : message.id === streamingAssistantMessageId
                        ? {
                            ...message,
                            metadata: {
                              ...message.metadata,
                              userMessageId: serverUserMessageId,
                            },
                          }
                        : message,
                  ),
                );
              });
            } else if (
              data.type === "text-delta" &&
              typeof data.delta === "string"
            ) {
              const hasVisibleDelta = data.delta.trim().length > 0;
              const hasRunningTool = [...streamToolCallsById.values()].some(
                (toolCall) => toolCall.status === "running",
              );
              const hasRunningStep = [...streamThinkingStepsById.values()].some(
                (step) => step.status === "in_progress",
              );
              if (
                assistantText.length > 0 &&
                hasVisibleDelta &&
                !hasRunningTool &&
                !hasRunningStep
              ) {
                flushSync(() => {
                  setMessages((previous) =>
                    previous.map((message) =>
                      message.id === streamingAssistantMessageId
                        ? {
                            ...message,
                            metadata: {
                              ...message.metadata,
                              [STREAM_TEXT_PAUSED_KEY]: false,
                            },
                          }
                        : message,
                    ),
                  );
                });
              }
              enqueueDelta(data.delta);
              startDeltaDrain();
            } else if (data.type === "text-interrupted") {
              flushSync(() => {
                setMessages((previous) =>
                  previous.map((message) =>
                    message.id === streamingAssistantMessageId
                      ? {
                          ...message,
                          metadata: {
                            ...message.metadata,
                            [STREAM_TEXT_INTERRUPTED_KEY]: true,
                            [STREAM_TEXT_PAUSED_KEY]: true,
                          },
                        }
                      : message,
                  ),
                );
              });
            } else if (isToolCallEvent(data)) {
              const nextToolCall = resolveToolCallFromStreamEvent({
                event: data,
                streamToolCallsById,
              });

              if (
                typeof data.id === "string" &&
                data.id.length > 0 &&
                data.id !== nextToolCall.id
              ) {
                streamToolCallsById.delete(data.id);
              }

              streamToolCallsById.set(nextToolCall.id, nextToolCall);
              syncStreamingToolCalls();
            } else if (data.type === "thinking-step") {
              const nextStep = normalizeThinkingStepRecord(data.step);
              if (nextStep) {
                mergeThinkingStepRecords(streamThinkingStepsById, nextStep);
                syncStreamingThinkingSteps();
              }
            } else if (
              data.type === "reasoning" &&
              typeof data.reasoning === "string"
            ) {
              const reasoning = data.reasoning;
              if (reasoning.length > 0) {
                const nextSegment = normalizeModelReasoningSegmentRecord(
                  data.segment,
                );
                flushSync(() => {
                  setMessages((previous) =>
                    previous.map((message) => {
                      if (message.id !== streamingAssistantMessageId) {
                        return message;
                      }

                      const currentReasoning = appendReasoningChunk(
                        toNullableString(message.metadata.reasoning) ??
                          undefined,
                        reasoning,
                      );
                      const currentSegments = Array.isArray(
                        message.metadata.reasoningSegments,
                      )
                        ? message.metadata.reasoningSegments
                            .map((item, index) =>
                              normalizeModelReasoningSegmentRecord(item, index),
                            )
                            .filter(
                              (item): item is ModelReasoningSegmentRecord =>
                                item !== null,
                            )
                        : [];
                      const reasoningSegments = nextSegment
                        ? [
                            ...currentSegments.filter(
                              (segment) => segment.id !== nextSegment.id,
                            ),
                            nextSegment,
                          ].sort(
                            (left, right) =>
                              (left.sequence ?? Number.MAX_SAFE_INTEGER) -
                              (right.sequence ?? Number.MAX_SAFE_INTEGER),
                          )
                        : currentSegments;

                      return {
                        ...message,
                        metadata: {
                          ...message.metadata,
                          reasoning: currentReasoning,
                          reasoningSegments,
                        },
                      };
                    }),
                  );
                });
              }
            } else if (data.type === "citations") {
              const citations = normalizeCitationRecords(data.citations);
              const availableCitations = normalizeCitationRecords(
                data.availableCitations,
              );
              syncStreamingCitations({
                citations,
                availableCitations:
                  availableCitations.length > 0
                    ? availableCitations
                    : citations,
              });
            } else if (
              data.type === "thread-title-update" &&
              typeof data.threadId === "string" &&
              typeof data.title === "string"
            ) {
              updateChatTitle(data.threadId, data.title);
              shouldPollThreadTitle = false;
            } else if (
              data.type === "thread-title-pending" &&
              typeof data.threadId === "string"
            ) {
              shouldPollThreadTitle = data.threadId === threadId;
              pendingTitleJobId =
                typeof data.jobId === "string" ? data.jobId : null;
            } else if (data.type === "error") {
              if (streamToolCallsById.size > 0) {
                for (const [
                  toolId,
                  toolCall,
                ] of streamToolCallsById.entries()) {
                  if (toolCall.status === "running") {
                    streamToolCallsById.set(toolId, {
                      ...toolCall,
                      status: "error",
                      error: toolCall.error ?? "Tool execution failed.",
                    });
                  }
                }
                syncStreamingToolCalls();
              }
              const errorMessage = data.error ?? "Model error";
              persistedAssistantMessageId =
                typeof data.messageId === "string" ? data.messageId : null;
              const messageId = persistedAssistantMessageId ?? tempAssistantId;
              const userMessageId =
                data.userMessageId ?? persistedUserMessageId;
              const previousAssistantMessageId = streamingAssistantMessageId;
              streamingAssistantMessageId = messageId;
              flushSync(() => {
                setMessages((previous) =>
                  previous.map((message) =>
                    message.id === previousAssistantMessageId
                      ? {
                          ...message,
                          id: messageId,
                          content: assistantText,
                          parentMessageId:
                            data.parentMessageId === undefined
                              ? message.parentMessageId
                              : data.parentMessageId,
                          metadata: {
                            ...message.metadata,
                            isError: true,
                            excludeFromContext: true,
                            error: errorMessage,
                            errorCode: data.code ?? null,
                            userMessageId,
                            sourceUserMessageId: userMessageId,
                            [STREAM_TEXT_PAUSED_KEY]: false,
                            toolCalls: [...streamToolCallsById.values()].filter(
                              (toolCall) =>
                                shouldRenderToolCall(toolCall, [
                                  ...streamThinkingStepsById.values(),
                                ]),
                            ),
                            thinkingSteps: [
                              ...streamThinkingStepsById.values(),
                            ],
                          },
                        }
                      : message,
                  ),
                );
              });
              streamError = new Error(errorMessage);
              streamEnded = true;
              break readLoop;
            } else if (
              data.type === "assistant-message" &&
              typeof data.messageId === "string"
            ) {
              persistedAssistantMessageId = data.messageId;
              const userMessageId =
                data.userMessageId ?? persistedUserMessageId;
              const previousAssistantMessageId = streamingAssistantMessageId;
              streamingAssistantMessageId = data.messageId;
              flushSync(() => {
                setMessages((previous) =>
                  previous.map((message) =>
                    message.id === previousAssistantMessageId
                      ? {
                          ...message,
                          id: data.messageId as string,
                          content: message.content,
                          parentMessageId:
                            data.parentMessageId === undefined
                              ? message.parentMessageId
                              : data.parentMessageId,
                          metadata: {
                            ...message.metadata,
                            isError: false,
                            excludeFromContext: false,
                            userMessageId,
                            sourceUserMessageId: userMessageId,
                            [STREAM_TEXT_PAUSED_KEY]: false,
                          },
                        }
                      : message,
                  ),
                );
              });
            } else if (data.type === "finish") {
              if (streamToolCallsById.size > 0) {
                for (const [
                  toolId,
                  toolCall,
                ] of streamToolCallsById.entries()) {
                  if (toolCall.status === "running") {
                    streamToolCallsById.set(toolId, {
                      ...toolCall,
                      status: "completed",
                    });
                  }
                }
                syncStreamingToolCalls();
              }
              if (streamThinkingStepsById.size > 0) {
                for (const [
                  stepId,
                  step,
                ] of streamThinkingStepsById.entries()) {
                  if (step.status === "in_progress") {
                    streamThinkingStepsById.set(stepId, {
                      ...step,
                      status: "completed",
                    });
                  }
                }
                syncStreamingThinkingSteps();
              }
              streamEnded = true;
              flushSync(() => {
                setMessages((previous) =>
                  previous.map((message) =>
                    message.id === streamingAssistantMessageId
                      ? {
                          ...message,
                          metadata: {
                            ...message.metadata,
                            [STREAM_TEXT_PAUSED_KEY]: false,
                          },
                        }
                      : message,
                  ),
                );
              });
              break readLoop;
            }
          }
        }

        streamEnded = true;
        if (drainPromise) {
          await drainPromise;
        }

        if (streamError) {
          throw streamError;
        }

        const usedSourceIds = new Set(input.sourceIds);
        messages.forEach((message) => {
          const messageSourceIds =
            resolveMessageEffectiveSourceIds(message) ??
            expandSelectedSources(
              librarySources,
              resolveMessageSourceIds(message),
            ).map((source) => source.id);
          messageSourceIds.forEach((sourceId) => {
            usedSourceIds.add(sourceId);
          });
        });
        const currentEffectiveSourceIds =
          preparedEffectiveSourceIds ??
          expandSelectedSources(librarySources, input.sourceIds).map(
            (source) => source.id,
          );
        currentEffectiveSourceIds.forEach((sourceId) => {
          usedSourceIds.add(sourceId);
        });
        updateChatSourceCount(threadId, usedSourceIds.size);

        window.setTimeout(() => {
          void loadThreadMessages();
        }, 0);
        if (shouldPollThreadTitle && pendingTitleJobId) {
          void pollThreadTitleJob(pendingTitleJobId);
        }
      } catch (error) {
        const errorMessage = getDisplayErrorMessage(error);
        if (!persistedAssistantMessageId) {
          setMessages((previous) => {
            const withoutFailedTemporaryMessages = previous.filter(
              (message) =>
                message.id !== streamingAssistantMessageId &&
                (!createdUserMessageId || message.id !== createdUserMessageId),
            );
            return withoutFailedTemporaryMessages;
          });
        } else {
          window.setTimeout(() => {
            void loadThreadMessages();
          }, 0);
        }

        toast.error(errorMessage);
      } finally {
        setIsStreaming(false);
      }
    },
    [
      catalogKindEnabled.llm,
      clearEditingState,
      loadThreadMessages,
      librarySources,
      messages,
      selectedModels,
      searchEnabled,
      streamWithSelectedLlm,
      threadId,
      thinkingSettings,
      updateChatTitle,
      updateChatSourceCount,
      workspaceId,
    ],
  );

  const streamThreadActionRef = useRef(streamThreadAction);
  const loadThreadMessagesRef = useRef(loadThreadMessages);

  useBrowserLayoutEffect(() => {
    streamThreadActionRef.current = streamThreadAction;
  }, [streamThreadAction]);

  useBrowserLayoutEffect(() => {
    loadThreadMessagesRef.current = loadThreadMessages;
  }, [loadThreadMessages]);

  useEffect(() => {
    clearEditingState();
    setActiveVersionByGroup({});
    setDisplayedCitations([]);
    setActiveCitationIndex(null);
    setPreviewCitation(null);
    latestSignatureByGroupRef.current = {};
  }, [clearEditingState, threadId, workspaceId]);

  // ── On mount: consume pending first message OR load history ───────────────
  useBrowserLayoutEffect(() => {
    if (!workspaceId) {
      return;
    }

    const bootstrapKey = `${workspaceId}:${threadId}`;
    if (bootstrappedThreadKeyRef.current === bootstrapKey) {
      return;
    }

    bootstrappedThreadKeyRef.current = bootstrapKey;

    const pendingKey = `chat:pending:${threadId}`;
    const raw = window.sessionStorage.getItem(pendingKey);

    if (raw) {
      window.sessionStorage.removeItem(pendingKey);
      try {
        const {
          content,
          sourceIds,
          skillIds,
          thinking,
          thinkingSettings: pendingThinkingSettings,
          searchEnabled: pendingSearchEnabled,
          modelState: pendingModelState,
        } = JSON.parse(raw) as {
          content: string;
          sourceIds: string[];
          skillIds?: string[];
          thinking?: RequestThinkingConfig;
          thinkingSettings?: PromptThinkingSettings;
          searchEnabled?: boolean;
          modelState?: {
            availableModels?: Record<ModelType, ModelItem[]>;
            catalogKindEnabled?: Record<ModelType, boolean>;
            selectedModels?: SelectedModels;
          };
        };
        const pendingSourceIds = Array.isArray(sourceIds)
          ? sourceIds.filter(
              (sourceId): sourceId is string => typeof sourceId === "string",
            )
          : [];
        const pendingSkillIds = Array.isArray(skillIds)
          ? skillIds
              .filter(
                (skillId): skillId is string => typeof skillId === "string",
              )
              .slice(0, 5)
          : [];
        persistActiveSourceIds(pendingSourceIds);
        setActiveSkillIds(pendingSkillIds);
        if (pendingThinkingSettings) {
          setHasSavedThinkingPreference(true);
          setThinkingSettings(pendingThinkingSettings);
        }
        if (typeof pendingSearchEnabled === "boolean") {
          setSearchEnabled(pendingSearchEnabled);
        }
        if (pendingModelState?.availableModels) {
          setAvailableModels(pendingModelState.availableModels);
        }
        if (pendingModelState?.catalogKindEnabled) {
          setCatalogKindEnabled(pendingModelState.catalogKindEnabled);
          setStreamWithSelectedLlm(pendingModelState.catalogKindEnabled.llm);
        }
        if (pendingModelState?.selectedModels) {
          setSelectedModels(pendingModelState.selectedModels);
        }
        void streamThreadActionRef.current({
          mode: "send",
          content,
          sourceIds: pendingSourceIds,
          skillIds: pendingSkillIds,
          thinking,
          searchEnabled: pendingSearchEnabled === true,
        });
      } catch {
        void loadThreadMessagesRef.current();
      }
      return;
    }

    void loadThreadMessagesRef.current();
  }, [persistActiveSourceIds, threadId, workspaceId]);

  // ── Public send handler (called by Composer) ──────────────────────────────
  const handleActiveVersionChange = useCallback(
    (input: { groupId: string; branchIndex: number }) => {
      setActiveVersionByGroup((previous) => {
        const next = {
          ...previous,
          [input.groupId]: input.branchIndex,
        };

        const changedGroup = messageGroups.find(
          (group) => group.groupId === input.groupId,
        );
        if (!changedGroup) {
          return next;
        }

        if (changedGroup.role === "user") {
          const selectedUserVersion = changedGroup.versions[input.branchIndex];
          if (!selectedUserVersion) {
            return next;
          }

          for (const assistantGroup of messageGroups) {
            if (assistantGroup.role !== "assistant") {
              continue;
            }

            let latestAssistantIndexForUser: number | null = null;
            assistantGroup.versions.forEach((version, versionIndex) => {
              if (version.sourceUserMessageId === selectedUserVersion.id) {
                latestAssistantIndexForUser = versionIndex;
              }
            });

            if (latestAssistantIndexForUser !== null) {
              next[assistantGroup.groupId] = latestAssistantIndexForUser;
              break;
            }
          }

          return next;
        }

        const selectedAssistantVersion =
          changedGroup.versions[input.branchIndex];
        if (!selectedAssistantVersion?.sourceUserMessageId) {
          return next;
        }

        for (const userGroup of messageGroups) {
          if (userGroup.role !== "user") {
            continue;
          }

          const userVersionIndex = userGroup.versions.findIndex(
            (version) =>
              version.id === selectedAssistantVersion.sourceUserMessageId,
          );
          if (userVersionIndex >= 0) {
            next[userGroup.groupId] = userVersionIndex;
            break;
          }
        }

        return next;
      });
    },
    [messageGroups],
  );

  const handleSendMessage = useCallback(
    async (content: string) => {
      const text = content.trim();
      if (!text || isStreaming) {
        return;
      }

      const contextSourceIds = resolveContextSourceIds({
        messages,
        activeSourceIds,
      });

      if (editingMessageId) {
        const editingAssistantGroup = editingAssistantMessageId
          ? messageGroups.find(
              (group) =>
                group.role === "assistant" &&
                group.versions.some(
                  (version) => version.id === editingAssistantMessageId,
                ),
            )
          : undefined;

        setActiveVersionByGroup((previous) => {
          const next = { ...previous };

          if (editingGroupId) {
            const userGroup = messageGroups.find(
              (group) => group.groupId === editingGroupId,
            );
            const nextUserBranchIndex = userGroup
              ? userGroup.versions.length
              : (editingBranchIndex ?? 0) + 1;

            next[editingGroupId] = Math.max(
              previous[editingGroupId] ?? 0,
              nextUserBranchIndex,
            );
          }

          if (editingAssistantGroup) {
            const nextAssistantBranchIndex =
              editingAssistantGroup.versions.length;
            next[editingAssistantGroup.groupId] = Math.max(
              previous[editingAssistantGroup.groupId] ?? 0,
              nextAssistantBranchIndex,
            );
          }

          return next;
        });

        pendingLatestVersionSelectionRef.current = {
          userGroupId: editingGroupId ?? undefined,
          assistantGroupId: editingAssistantGroup?.groupId,
        };

        const editSourceIds = resolveEditSourceIds({
          activeSourceIds,
          editingMessageId,
          groups: messageGroups,
        });

        await streamThreadAction({
          mode: "edit",
          content: text,
          sourceIds: editSourceIds,
          skillIds: activeSkillIds,
          searchEnabled,
          userMessageId: editingMessageId,
          assistantMessageId: editingAssistantMessageId,
        });
        return;
      }

      await streamThreadAction({
        mode: "send",
        content: text,
        sourceIds: contextSourceIds,
        skillIds: activeSkillIds,
        searchEnabled,
      });
    },
    [
      editingAssistantMessageId,
      editingBranchIndex,
      editingGroupId,
      editingMessageId,
      isStreaming,
      messageGroups,
      messages,
      activeSourceIds,
      activeSkillIds,
      searchEnabled,
      streamThreadAction,
    ],
  );

  const handleRefreshLatest = useCallback(
    async (input: {
      groupId: string;
      assistantMessageId: string;
      branchIndex: number;
    }) => {
      if (isStreaming) {
        return;
      }

      const assistantGroup = messageGroups.find(
        (group) => group.groupId === input.groupId,
      );
      const nextBranchIndex = assistantGroup
        ? assistantGroup.versions.length
        : input.branchIndex + 1;

      setActiveVersionByGroup((previous) => ({
        ...previous,
        [input.groupId]: Math.max(
          previous[input.groupId] ?? 0,
          nextBranchIndex,
        ),
      }));
      pendingLatestVersionSelectionRef.current = {
        assistantGroupId: input.groupId,
      };

      const refreshSourceIds = resolveRefreshSourceIds({
        activeSourceIds,
        assistantMessageId: input.assistantMessageId,
        groups: messageGroups,
      });

      await streamThreadAction({
        mode: "refresh",
        sourceIds: refreshSourceIds,
        skillIds: activeSkillIds,
        searchEnabled,
        assistantMessageId: input.assistantMessageId,
      });
    },
    [
      activeSourceIds,
      activeSkillIds,
      isStreaming,
      messageGroups,
      searchEnabled,
      streamThreadAction,
    ],
  );

  const handleRestartFromMessage = useCallback(
    (input: {
      groupId: string;
      messageId: string;
      message: string;
      assistantMessageId: string | null;
      branchIndex: number;
    }) => {
      if (editingMessageId === input.messageId) {
        cancelEditing();
        return;
      }

      setEditingMessageId(input.messageId);
      setEditingAssistantMessageId(input.assistantMessageId);
      setEditingGroupId(input.groupId);
      setEditingBranchIndex(input.branchIndex);
      setComposerInitialInput(input.message);
      setComposerResetKey((value) => value + 1);
    },
    [cancelEditing, editingMessageId],
  );

  const selectedSources = useMemo(
    () => expandSelectedSources(librarySources, activeSourceIds),
    [activeSourceIds, librarySources],
  );

  return (
    <div className="flex h-full w-full overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="sticky top-0 z-10 shrink-0 border-b border-border/70 bg-background/95 backdrop-blur">
          <div className="flex h-16 items-center justify-between gap-3 px-4 md:px-6 xl:px-8">
            <div className="flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden">
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-base font-semibold text-foreground">
                  {threadTitle}
                </h1>
              </div>
              <HeaderModelSelector
                availableModels={availableModels}
                onModelSelect={handleModelSelect}
                selectedModels={selectedModels}
                setSelectedModels={setSelectedModels}
              />
            </div>

            <div className="ml-auto flex items-center gap-2">
              <Button
                onClick={toggleSourcesVisible}
                size="icon-sm"
                title={sourcesVisible ? "Hide sources" : "Show sources"}
                type="button"
                variant="outline"
              >
                {sourcesVisible ? (
                  <PanelRightClose className="h-4 w-4" />
                ) : (
                  <PanelRightOpen className="h-4 w-4" />
                )}
                <span className="sr-only">
                  {sourcesVisible ? "Hide sources" : "Show sources"}
                </span>
              </Button>
            </div>
          </div>
        </header>

        <ChatCanvas
          activeVersionByGroup={activeVersionByGroup}
          allSources={librarySources}
          availableSkills={availableSkills}
          composerInitialInput={composerInitialInput}
          composerResetKey={composerResetKey}
          highlightedMessageId={highlightedMessageId}
          isEditing={Boolean(editingMessageId && editingGroupId)}
          isStreaming={isStreaming}
          messageGroups={messageGroups}
          mode="thread"
          onActiveVersionChange={handleActiveVersionChange}
          onCancelEditing={cancelEditing}
          onCitationClick={handleCitationClick}
          onRemoveSource={(id) =>
            persistActiveSourceIds(activeSourceIds.filter((x) => x !== id))
          }
          onRefreshLatest={handleRefreshLatest}
          onRestartFromMessage={handleRestartFromMessage}
          onSendMessage={handleSendMessage}
          onSkillSelectionChange={setActiveSkillIds}
          searchEnabled={searchEnabled}
          onSearchEnabledChange={setSearchEnabled}
          selectedSources={selectedSources}
          selectedSkillIds={activeSkillIds}
          sourcesVisible={sourcesVisible}
          thinkingCapabilities={selectedModels.llm?.capabilities}
          thinkingSettings={thinkingSettings}
          onThinkingSettingsChange={handleThinkingSettingsChange}
          threadTitle={threadTitle}
          workspaceId={workspaceId}
        />
      </div>

      {sourcesVisible ? (
        <SourcesHub
          activeCitationIndex={activeCitationIndex}
          citations={displayedCitations}
          currentCitationMessageId={activeAssistantVersion?.id ?? null}
          installedSkills={availableSkills}
          mode="thread"
          onCitationLocate={scrollToMessage}
          onCitationOpen={handleSourceHubCitationOpen}
          onSkillSelectionChange={setActiveSkillIds}
          onSelectionChange={persistActiveSourceIds}
          onSourceLoad={setLibrarySources}
          selectedIds={activeSourceIds}
          selectedSkillIds={activeSkillIds}
          threadCitations={threadCitations}
          workspaceId={workspaceId}
        />
      ) : null}

      <SourcePreviewPanel
        citation={previewCitation}
        onOpenChange={(open) => {
          if (!open) {
            setPreviewCitation(null);
          }
        }}
        open={Boolean(previewCitation)}
        workspaceId={workspaceId}
      />
    </div>
  );
}
