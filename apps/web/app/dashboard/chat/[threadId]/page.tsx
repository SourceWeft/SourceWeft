"use client";

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { useDashboardChatState } from "../../_components/dashboard-chat-state";
import {
  allModels,
  HeaderModelSelector,
  mapCatalogKindsToModelItems,
  resolveSelectedModels,
  type ModelAliasSettings,
  type ModelItem,
  type ModelType,
} from "../_components/header-model-selector";
import {
  ChatCanvas,
  type CitationRecord,
  type MessageVersion,
  type ThinkingStepRecord,
  type ToolCallRecord,
  type VersionedMessageGroup,
} from "../_components/chat-canvas";
import { SourcesHub, type ThreadCitationRecord } from "../_components/sources-hub";
import { SourcePreviewPanel } from "../_components/source-preview-panel";
import type { SourceItem } from "../_components/mock-data";
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

const TOOLS_WITHOUT_UI = new Set([
  "retrieve",
]);

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

function getDisplayErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Failed to send message.";
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

function resolveCitationsFromMetadata(metadata: Record<string, unknown>): CitationRecord[] {
  const retrieval = toObjectRecord(metadata.retrieval);
  return normalizeCitationRecords(retrieval?.citations);
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

      if (
        citation === null ||
        !sourceId ||
        !documentId ||
        !chunkId ||
        score === null ||
        excerpt === null
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

      return citationRecord;
    })
    .filter((item): item is CitationRecord => item !== null);
}

function resolveMessageSourceIds(message: ChatMessageItem) {
  const rawSourceIds = message.metadata.sourceIds;
  if (!Array.isArray(rawSourceIds)) {
    return [] as string[];
  }

  return rawSourceIds.filter((sourceId): sourceId is string => typeof sourceId === "string");
}

const CITATION_PATTERN = /[[【]\u200B?citation:\s*([\w:-]+(?:\s*,\s*[\w:-]+)*)\s*\u200B?[\]】]/g;

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
  const visibleEntries = scopedEntries.length > 0 ? scopedEntries : versionEntries;
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
  selectedSourceIds: string[];
}) {
  if (input.selectedSourceIds.length > 0) {
    return input.selectedSourceIds;
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

function normalizeThinkingStepRecord(value: unknown): ThinkingStepRecord | null {
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
    title,
    status,
    items,
    sequence: toNullableNumber(record.sequence) ?? undefined,
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

function shouldRenderToolCall(toolCall: ToolCallRecord) {
  return !TOOLS_WITHOUT_UI.has(toolCall.tool);
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
  toolCall?: unknown;
  step?: unknown;
  citations?: unknown;
};

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
      : existing?.tool ?? "tool");

  const normalizedInput =
    normalizedToolCall?.input ??
    toObjectRecord(input.event.input) ??
    (typeof input.event.query === "string"
      ? { query: input.event.query }
      : existing?.input ?? {});

  const normalizedOutput =
    normalizeToolOutput(
      normalizedToolCall?.output ??
    (input.event.type === "tool-call-event"
      ? (input.event.data ?? existing?.output ?? null)
      : input.event.type === "tool-call-result"
        ? (input.event.output !== undefined
            ? input.event.output
            : typeof input.event.hitCount === "number"
              ? { hitCount: input.event.hitCount }
              : (existing?.output ?? null))
        : (existing?.output ?? null)),
    );

  const normalizedStatus = (() => {
    if (normalizedToolCall) {
      return normalizedToolCall.status;
    }

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
    .filter((item) => shouldRenderToolCall(item));
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
        ? userRootToTurnId.get(rootId) ?? `turn:${rootId}`
        : assistantRootToTurnId.get(rootId) ?? `turn:${rootId}`;
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
      const latestVersion = sortedVersions[sortedVersions.length - 1] ??
        sortedVersions[0];

      return {
        groupId,
        turnId: group.turnId,
        latestVersionId: latestVersion?.id ?? groupId,
        role: group.role,
        versions: sortedVersions.map((version) => ({
          id: version.id,
          content: version.content,
          citations: group.role === "assistant"
            ? resolveCitationsFromMetadata(version.metadata)
            : undefined,
          isError: version.metadata.isError === true,
          sourceIds: group.role === "user"
            ? resolveMessageSourceIds(version)
            : undefined,
          sourceAssistantMessageId: group.role === "assistant"
            ? (toNullableString(version.metadata.sourceAssistantMessageId) ?? null)
            : undefined,
          sourceUserMessageId: group.role === "assistant"
            ? (assistantSourceUserById.get(version.id) ?? null)
            : undefined,
          toolCalls: resolveToolCallsFromMetadata(version.metadata),
          thinkingSteps: group.role === "assistant"
            ? resolveThinkingStepsFromMetadata(version.metadata)
            : undefined,
        })),
      } satisfies VersionedMessageGroup;
    })
    .sort((left, right) => {
      const leftTurnOrder = turnOrder.get(left.turnId ?? "") ?? Number.MAX_SAFE_INTEGER;
      const rightTurnOrder = turnOrder.get(right.turnId ?? "") ?? Number.MAX_SAFE_INTEGER;
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
    updateChatSourceCount,
    workspaceId,
  } = useDashboardChatState();

  // ── Thread metadata from sidebar list ─────────────────────────────────────
  const chatItem = privateChats.find((c) => c.id === threadId);
  const threadTitle = chatItem?.title ?? "Chat";

  // ── Messaging state ────────────────────────────────────────────────────────
  const [messages, setMessages] = useState<ChatMessageItem[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [showThinkingPlaceholder, setShowThinkingPlaceholder] = useState(false);
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
  const [activeCitationIndex, setActiveCitationIndex] = useState<number | null>(null);
  const [previewCitation, setPreviewCitation] = useState<CitationRecord | null>(null);
  const [displayedCitations, setDisplayedCitations] = useState<CitationRecord[]>([]);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const latestSignatureByGroupRef = useRef<Record<string, string>>({});

  // ── Sources state ──────────────────────────────────────────────────────────
  const [librarySources, setLibrarySources] = useState<SourceItem[]>([]);
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);
  const [selectionLoaded, setSelectionLoaded] = useState(false);

  // ── Composer state ─────────────────────────────────────────────────────────
  const [composerInitialInput, setComposerInitialInput] = useState("");
  const [composerResetKey, setComposerResetKey] = useState(0);
  const [selectedModels, setSelectedModels] = useState<
    Record<ModelType, ModelItem>
  >(() => resolveSelectedModels({ availableModels: allModels }));
  const [availableModels, setAvailableModels] = useState<
    Record<ModelType, ModelItem[]>
  >(allModels);
  const [catalogKindEnabled, setCatalogKindEnabled] = useState<
    Record<ModelType, boolean>
  >(EMPTY_MODEL_KIND_FLAGS);
  const [streamWithSelectedLlm, setStreamWithSelectedLlm] = useState(false);

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

  // Tracks whether initial bootstrap was already processed for this thread key.
  const bootstrappedThreadKeyRef = useRef<string | null>(null);

  // ── Session storage: persist selected source IDs per thread ───────────────
  const selectionStorageKey = useMemo(
    () =>
      workspaceId ? `chat:sources:${workspaceId}:${threadId}` : null,
    [workspaceId, threadId],
  );
  const currentSelectionStorageKey = useMemo(
    () => (workspaceId ? `chat:sources:${workspaceId}:current` : null),
    [workspaceId],
  );

  useEffect(() => {
    setSelectionLoaded(false);
    if (!selectionStorageKey) {
      setSelectedSourceIds([]);
      setSelectionLoaded(true);
      return;
    }
    const raw = window.sessionStorage.getItem(selectionStorageKey);
    if (!raw) {
      setSelectedSourceIds([]);
      setSelectionLoaded(true);
      return;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        setSelectedSourceIds(
          parsed.filter((item): item is string => typeof item === "string"),
        );
      } else {
        setSelectedSourceIds([]);
      }
    } catch {
      setSelectedSourceIds([]);
    } finally {
      setSelectionLoaded(true);
    }
  }, [selectionStorageKey]);

  const persistSelectedSourceIds = useCallback((sourceIds: string[]) => {
    setSelectedSourceIds(sourceIds);
    if (selectionStorageKey) {
      window.sessionStorage.setItem(selectionStorageKey, JSON.stringify(sourceIds));
    }
    if (currentSelectionStorageKey) {
      window.sessionStorage.setItem(currentSelectionStorageKey, JSON.stringify(sourceIds));
    }
  }, [currentSelectionStorageKey, selectionStorageKey]);

  useEffect(() => {
    if (!selectionLoaded || !selectionStorageKey) return;
    window.sessionStorage.setItem(
      selectionStorageKey,
      JSON.stringify(selectedSourceIds),
    );
    if (currentSelectionStorageKey) {
      window.sessionStorage.setItem(
        currentSelectionStorageKey,
        JSON.stringify(selectedSourceIds),
      );
    }
  }, [currentSelectionStorageKey, selectedSourceIds, selectionLoaded, selectionStorageKey]);

  const messageGroups = useMemo(
    () => buildVersionedMessageGroups(messages),
    [messages],
  );

  const activeAssistantVersion = useMemo(() => {
    for (let groupIndex = messageGroups.length - 1; groupIndex >= 0; groupIndex -= 1) {
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
    () => resolveUsedCitationsForText({
      citations: activeAssistantVersion?.citations,
      text: activeAssistantVersion?.content ?? "",
    }),
    [activeAssistantVersion],
  );
  const activeAssistantCitations = activeAssistantVersion?.citations ?? EMPTY_CITATIONS;
  const visibleCitations = useMemo(
    () => (activeCitations.length > 0 ? activeCitations : activeAssistantCitations),
    [activeAssistantCitations, activeCitations],
  );
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
          : (version.citations ?? EMPTY_CITATIONS);

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
          current.every((citation, index) => citation.chunkId === visibleCitations[index]?.chunkId)
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

      for (const group of messageGroups) {
        const maxIndex = Math.max(group.versions.length - 1, 0);
        const signature = `${group.groupId}:${group.latestVersionId}`;
        nextSignatures[group.groupId] = signature;

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

      latestSignatureByGroupRef.current = nextSignatures;
      return next;
    });
  }, [messageGroups]);

  const loadThreadMessages = useCallback(
    async () => {
    if (!workspaceId) {
      setMessages([]);
      return;
    }

    try {
      const result = await contentClient.listThreadMessages(workspaceId, threadId);
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

      setMessages(
        serverMessages.sort(
          (left, right) =>
            new Date(left.createdAt).getTime() -
            new Date(right.createdAt).getTime(),
        ),
      );
    } catch {
      setMessages([]);
    }
    },
    [threadId, workspaceId],
  );

  const loadThreadModelState = useCallback(async () => {
    if (!workspaceId) {
      setAvailableModels(allModels);
      setSelectedModels(resolveSelectedModels({ availableModels: allModels }));
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
          fallbackModels: allModels,
        }),
      );
      setStreamWithSelectedLlm(kindEnabled.llm);
    } catch {
      setCatalogKindEnabled(EMPTY_MODEL_KIND_FLAGS);
      setAvailableModels(allModels);
      setSelectedModels(resolveSelectedModels({ availableModels: allModels }));
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
        await contentClient.updateThreadModelSettings(workspaceId, threadId, patch);
        if (input.type === "llm") {
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
    [catalogKindEnabled, loadThreadModelState, threadId, workspaceId],
  );

  const streamThreadAction = useCallback(
    async (input: {
      mode: "send" | "refresh" | "edit";
      content?: string;
      sourceIds: string[];
      selectedSourceIds?: string[];
      userMessageId?: string | null;
      assistantMessageId?: string | null;
    }) => {
      if (!workspaceId) {
        return;
      }

      const isFirstThreadMessage =
        messages.filter((message) => message.role === "user").length === 0;

      setIsStreaming(true);
      setShowThinkingPlaceholder(isFirstThreadMessage);
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
        temporaryMessages.push({
          id: tempUserId,
          role: "user",
          content: input.content ?? "",
          parentMessageId: input.mode === "edit"
            ? (input.userMessageId ?? latestUserMessage?.id ?? null)
            : null,
          metadata: {
            sourceIds: input.selectedSourceIds ?? input.sourceIds,
            versionOf: input.mode === "edit"
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
        parentMessageId: input.mode === "send"
          ? null
          : (input.assistantMessageId ?? latestAssistantMessage?.id ?? null),
        metadata: {
          userMessageId: tempUserId ?? input.userMessageId ?? latestUserMessage?.id ?? null,
          versionOf: input.mode === "send"
            ? null
            : (input.assistantMessageId ?? latestAssistantMessage?.id ?? null),
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

      let thinkingTimer: number | null = null;
      let persistedUserMessageId = tempUserId ?? input.userMessageId ?? null;
      let persistedAssistantMessageId: string | null = null;
      const streamToolCallsById = new Map<string, ToolCallRecord>();
      const streamThinkingStepsById = new Map<string, ThinkingStepRecord>();
      let streamingAssistantMessageId = tempAssistantId;

      try {
        const requestBody: Record<string, unknown> = {
          mode: input.mode,
          sourceIds: input.sourceIds,
          selectedSourceIds: input.selectedSourceIds ?? input.sourceIds,
        };
        const selectedLlmAlias =
          streamWithSelectedLlm && catalogKindEnabled.llm
            ? selectedModels.llm?.id
            : undefined;
        if (typeof selectedLlmAlias === "string" && selectedLlmAlias.length > 0) {
          requestBody.llm = {
            modelAlias: selectedLlmAlias,
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

        if (!isFirstThreadMessage) {
          thinkingTimer = window.setTimeout(() => {
            if (!hasRenderedDelta) {
              setShowThinkingPlaceholder(true);
            }
          }, 120);
        }

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
                if (thinkingTimer) {
                  window.clearTimeout(thinkingTimer);
                  thinkingTimer = null;
                }
                setShowThinkingPlaceholder(false);
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
          const toolCalls = [...streamToolCallsById.values()].filter((toolCall) =>
            shouldRenderToolCall(toolCall)
          );
          flushSync(() => {
            setMessages((previous) =>
              previous.map((message) =>
                message.id === streamingAssistantMessageId
                  ? {
                      ...message,
                      metadata: {
                        ...message.metadata,
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
          flushSync(() => {
            setMessages((previous) =>
              previous.map((message) =>
                message.id === streamingAssistantMessageId
                  ? {
                      ...message,
                      metadata: {
                        ...message.metadata,
                        thinkingSteps,
                      },
                    }
                  : message,
              ),
            );
          });
        };

        const syncStreamingCitations = (citations: CitationRecord[]) => {
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
                          citations,
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
              persistedUserMessageId = data.messageId;
              flushSync(() => {
                setMessages((previous) =>
                  previous.map((message) =>
                    message.id === streamingAssistantMessageId
                      ? {
                          ...message,
                          metadata: {
                            ...message.metadata,
                            userMessageId: persistedUserMessageId,
                          },
                        }
                      : message,
                  ),
                );
              });
            } else if (data.type === "text-delta" && typeof data.delta === "string") {
              enqueueDelta(data.delta);
              startDeltaDrain();
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
                streamThinkingStepsById.set(nextStep.id, nextStep);
                syncStreamingThinkingSteps();
              }
            } else if (data.type === "citations") {
              const citations = normalizeCitationRecords(data.citations);
              if (citations.length > 0) {
                syncStreamingCitations(citations);
              }
            } else if (data.type === "error") {
              if (streamToolCallsById.size > 0) {
                for (const [toolId, toolCall] of streamToolCallsById.entries()) {
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
              const userMessageId = data.userMessageId ?? persistedUserMessageId;
              const previousAssistantMessageId = streamingAssistantMessageId;
              streamingAssistantMessageId = messageId;
              flushSync(() => {
                setMessages((previous) =>
                  previous.map((message) =>
                    message.id === previousAssistantMessageId
                      ? {
                          ...message,
                          id: messageId,
                          content: errorMessage,
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
                            toolCalls: [...streamToolCallsById.values()].filter(shouldRenderToolCall),
                            thinkingSteps: [...streamThinkingStepsById.values()],
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
                          metadata: {
                            ...message.metadata,
                            isError: false,
                            excludeFromContext: false,
                          },
                        }
                      : message,
                  ),
                );
              });
            } else if (data.type === "finish") {
              if (streamToolCallsById.size > 0) {
                for (const [toolId, toolCall] of streamToolCallsById.entries()) {
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
                for (const [stepId, step] of streamThinkingStepsById.entries()) {
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
              break readLoop;
            }
          }
        }

        streamEnded = true;
        if (drainPromise) {
          await drainPromise;
        }

        if (thinkingTimer) {
          window.clearTimeout(thinkingTimer);
          thinkingTimer = null;
        }
        setShowThinkingPlaceholder(false);

        if (streamError) {
          throw streamError;
        }

        const usedSourceIds = new Set(input.sourceIds);
        messages.forEach((message) => {
          resolveMessageSourceIds(message).forEach((sourceId) => {
            usedSourceIds.add(sourceId);
          });
        });
        updateChatSourceCount(threadId, usedSourceIds.size);

        window.setTimeout(() => {
          void loadThreadMessages();
        }, 0);
      } catch (error) {
        if (thinkingTimer) {
          window.clearTimeout(thinkingTimer);
          thinkingTimer = null;
        }
        setShowThinkingPlaceholder(false);

        const errorMessage = getDisplayErrorMessage(error);
        if (!persistedAssistantMessageId) {
          setMessages((previous) => {
            const withoutAssistant = previous.filter(
              (message) => message.id !== streamingAssistantMessageId,
            );
            return withoutAssistant;
          });
        } else {
          window.setTimeout(() => {
            void loadThreadMessages();
          }, 0);
        }

        toast.error(errorMessage);
      } finally {
        if (thinkingTimer) {
          window.clearTimeout(thinkingTimer);
        }
        setShowThinkingPlaceholder(false);
        setIsStreaming(false);
      }
    },
    [
      catalogKindEnabled.llm,
      clearEditingState,
      loadThreadMessages,
      messages,
      selectedModels,
      streamWithSelectedLlm,
      threadId,
      updateChatSourceCount,
      workspaceId,
    ],
  );

  const streamThreadActionRef = useRef(streamThreadAction);
  const loadThreadMessagesRef = useRef(loadThreadMessages);

  useEffect(() => {
    streamThreadActionRef.current = streamThreadAction;
  }, [streamThreadAction]);

  useEffect(() => {
    loadThreadMessagesRef.current = loadThreadMessages;
  }, [loadThreadMessages]);

  useEffect(() => {
    setShowThinkingPlaceholder(false);
    clearEditingState();
    setActiveVersionByGroup({});
    setDisplayedCitations([]);
    setActiveCitationIndex(null);
    setPreviewCitation(null);
    latestSignatureByGroupRef.current = {};
  }, [clearEditingState, threadId, workspaceId]);

  // ── On mount: consume pending first message OR load history ───────────────
  useEffect(() => {
    if (!workspaceId) {
      return;
    }

    const bootstrapKey = `${workspaceId}:${threadId}`;
    if (bootstrappedThreadKeyRef.current === bootstrapKey) {
      return;
    }

    const bootstrapTimer = window.setTimeout(() => {
      if (bootstrappedThreadKeyRef.current === bootstrapKey) {
        return;
      }
      bootstrappedThreadKeyRef.current = bootstrapKey;

      const pendingKey = `chat:pending:${threadId}`;
      const raw = sessionStorage.getItem(pendingKey);

      if (raw) {
        sessionStorage.removeItem(pendingKey);
        try {
          const { content, sourceIds } = JSON.parse(raw) as {
            content: string;
            sourceIds: string[];
          };
          const pendingSourceIds = Array.isArray(sourceIds)
            ? sourceIds.filter((sourceId): sourceId is string => typeof sourceId === "string")
            : [];
          persistSelectedSourceIds(pendingSourceIds);
          void streamThreadActionRef.current({
            mode: "send",
            content,
            sourceIds: pendingSourceIds,
            selectedSourceIds: pendingSourceIds,
          });
        } catch {
          void loadThreadMessagesRef.current();
        }
        return;
      }

      void loadThreadMessagesRef.current();
    }, 0);

    return () => {
      window.clearTimeout(bootstrapTimer);
    };
  }, [persistSelectedSourceIds, threadId, workspaceId]);

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

        const selectedAssistantVersion = changedGroup.versions[input.branchIndex];
        if (!selectedAssistantVersion?.sourceUserMessageId) {
          return next;
        }

        for (const userGroup of messageGroups) {
          if (userGroup.role !== "user") {
            continue;
          }

          const userVersionIndex = userGroup.versions.findIndex(
            (version) => version.id === selectedAssistantVersion.sourceUserMessageId,
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
        selectedSourceIds,
      });

      if (editingMessageId) {
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

          if (editingAssistantMessageId) {
            const assistantGroup = messageGroups.find(
              (group) =>
                group.role === "assistant" &&
                group.versions.some(
                  (version) => version.id === editingAssistantMessageId,
                ),
            );

            if (assistantGroup) {
              const nextAssistantBranchIndex = assistantGroup.versions.length;
              next[assistantGroup.groupId] = Math.max(
                previous[assistantGroup.groupId] ?? 0,
                nextAssistantBranchIndex,
              );
            }
          }

          return next;
        });

        await streamThreadAction({
          mode: "edit",
          content: text,
          sourceIds: contextSourceIds,
          selectedSourceIds,
          userMessageId: editingMessageId,
          assistantMessageId: editingAssistantMessageId,
        });
        return;
      }

      await streamThreadAction({
        mode: "send",
        content: text,
        sourceIds: contextSourceIds,
        selectedSourceIds,
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
      selectedSourceIds,
      streamThreadAction,
    ],
  );

  const handleRefreshLatest = useCallback(async (input: {
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
      [input.groupId]: Math.max(previous[input.groupId] ?? 0, nextBranchIndex),
    }));

    const contextSourceIds = resolveContextSourceIds({
      messages,
      selectedSourceIds,
    });

    await streamThreadAction({
      mode: "refresh",
      sourceIds: contextSourceIds,
      selectedSourceIds,
      assistantMessageId: input.assistantMessageId,
    });
  }, [isStreaming, messageGroups, messages, selectedSourceIds, streamThreadAction]);

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

  const selectedSources = librarySources.filter((s) =>
    selectedSourceIds.includes(s.id),
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
          composerInitialInput={composerInitialInput}
          composerResetKey={composerResetKey}
          highlightedMessageId={highlightedMessageId}
          isEditing={Boolean(editingMessageId && editingGroupId)}
          isStreaming={isStreaming}
          showThinkingPlaceholder={showThinkingPlaceholder}
          messageGroups={messageGroups}
          mode="thread"
          onActiveVersionChange={handleActiveVersionChange}
          onCancelEditing={cancelEditing}
          onCitationClick={handleCitationClick}
          onRemoveSource={(id) =>
            persistSelectedSourceIds(selectedSourceIds.filter((x) => x !== id))
          }
          onRefreshLatest={handleRefreshLatest}
          onRestartFromMessage={handleRestartFromMessage}
          onSendMessage={handleSendMessage}
          selectedSources={selectedSources}
          sourcesVisible={sourcesVisible}
          threadTitle={threadTitle}
          workspaceId={workspaceId}
        />
      </div>

      {sourcesVisible ? (
        <SourcesHub
          activeCitationIndex={activeCitationIndex}
          citations={displayedCitations}
          currentCitationMessageId={activeAssistantVersion?.id ?? null}
          mode="thread"
          onCitationLocate={scrollToMessage}
          onCitationOpen={handleSourceHubCitationOpen}
          onSelectionChange={persistSelectedSourceIds}
          onSourceLoad={setLibrarySources}
          selectedIds={selectedSourceIds}
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
