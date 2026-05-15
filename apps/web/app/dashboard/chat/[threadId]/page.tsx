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
import { useRouter } from "next/navigation";
import { Keyboard, PanelRightClose, PanelRightOpen } from "lucide-react";
import { toast } from "sonner";
import { MessageResponse } from "@sourceweft/ui-web/components/ai-elements/message";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@sourceweft/ui-web/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@sourceweft/ui-web/components/ui/sheet";
import { useDashboardChatState } from "../../_components/dashboard-chat-state";
import {
  DASHBOARD_WORKSPACE_SHORTCUT_LIMIT,
  DashboardShortcutsDialog,
  getDashboardWorkspaceShortcutKeys,
  useDashboardShortcuts,
  useDashboardShortcutPlatform,
  type DashboardShortcutDefinition,
} from "../../_components/dashboard-shortcuts";
import { dispatchDashboardBillingSummaryRefresh } from "../../_components/dashboard-billing-summary-refresh";
import {
  emptyModelCatalog,
  HeaderModelSelector,
  mapCatalogKindsToModelItems,
  resolveSelectedModels,
  resolveSelectedModelsWithByok,
  type ModelAliasSettings,
  type ModelItem,
  type SelectedModels,
  type ModelType,
} from "../_components/header-model-selector";
import {
  buildByokModelExecution,
  normalizeByokProviderOptions,
  readStoredByokState,
  writeStoredByokState,
  type ByokCredentialItem,
  type ByokModelSelection,
  type ByokProviderOption,
  type ByokSavedModelItem,
} from "../_components/byok-state";
import { writeStoredModelSelection } from "../_components/model-selection-storage";
import {
  ByokModelConfigDialog,
  type ByokModelConfigDefaults,
} from "../_components/byok-model-config-dialog";
import {
  applySkillModelPresetState,
  DEFAULT_MODEL_SELECTION_SOURCES,
  type ModelSelectionSources,
} from "../_components/skill-model-presets";
import {
  buildChatToolsRequest,
  ChatCanvas,
  DEFAULT_PROMPT_THINKING_SETTINGS,
  type ArtifactPreviewRecord,
  type ChatSendInput,
  type ChatSkillItem,
  type ChatToolName,
  type CitationRecord,
  type MessageVersion,
  type MessageRenderBlock,
  type ModelReasoningSegmentRecord,
  type PromptInputMentionSourceLoader,
  type PromptThinkingSettings,
  type ThinkingStepRecord,
  type ToolCallRecord,
  type VersionedMessageGroup,
} from "../_components/chat-canvas";
import {
  AGENT_TOOL_NAMES,
  isGeneratedImageArtifactToolName,
  isWorkfileWriteToolName,
} from "@sourceweft/sdk";
import {
  ArtifactPreviewPanel,
  SourcesHub,
  type ArtifactListItem,
  type ThreadCitationRecord,
} from "../_components/sources-hub";
import { SourcePreviewPanel } from "../_components/source-preview-panel";
import {
  expandSelectedSources,
  type SourceItem,
} from "../_components/source-types";
import {
  getSourceSelectionStorageKey,
  readStoredSourceSelection,
  writeStoredSourceSelection,
} from "../_components/source-selection-storage";
import {
  getCachedWorkspaceSources,
  hasCachedWorkspaceSources,
  setCachedWorkspaceSources,
} from "../_components/source-library-cache";
import {
  desktopBridge,
  handleDesktopAuthDeepLink,
} from "../../../../lib/desktop-bridge";
import { contentClient } from "../../../../lib/sdk";
import {
  HttpClientError,
  SOURCEWEFT_WEB_RUN_IDEMPOTENCY_PREFIX,
  SOURCEWEFT_WEB_RUN_STOP_SUFFIX,
} from "@sourceweft/sdk";

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

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);

  return matches;
}

function mergeSourceIds(...sourceIdGroups: (string[] | undefined)[]) {
  return [
    ...new Set(
      sourceIdGroups.flatMap((sourceIds) => sourceIds ?? []).filter(Boolean),
    ),
  ];
}

function getSearchPreferenceStorageKey(workspaceId: string) {
  return `chat:search:${SEARCH_PREFERENCE_STORAGE_VERSION}:${workspaceId}:current`;
}

function removeDisabledToolSkills(input: {
  skillIds: string[];
  availableSkills: ChatSkillItem[];
  disabledToolNames: ChatToolName[];
}) {
  if (input.disabledToolNames.length === 0) {
    return input.skillIds;
  }
  const disabledToolNameSet = new Set(input.disabledToolNames);
  return input.skillIds.filter((skillId) => {
    const skill = input.availableSkills.find((item) => item.id === skillId);
    return !skill?.tools?.some((toolName) =>
      disabledToolNameSet.has(toolName as ChatToolName),
    );
  });
}

type ThreadMessageItem = Awaited<
  ReturnType<typeof contentClient.listThreadMessages>
>["items"][number];
type WorkfileDetail = Awaited<
  ReturnType<typeof contentClient.getWorkingFile>
>["file"];

type ChatMessageItem = {
  id: string;
  role: "user" | "assistant";
  content: string;
  contentJson: Record<string, unknown>;
  parentMessageId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

const STREAM_TEXT_PAUSED_KEY = "isTextPaused";
const STREAM_TEXT_INTERRUPTED_KEY = "isTextInterrupted";
const STREAM_RENDER_KEY = "renderKey";
const TITLE_POLL_INTERVAL_MS = 1000;
const TITLE_POLL_TIMEOUT_MS = 60000;
const THREAD_MESSAGES_LOAD_RETRY_DELAYS_MS = [300, 1000, 2500] as const;

type PendingLatestVersionSelection = {
  userGroupId?: string;
  assistantGroupId?: string;
  turnId?: string;
};

type RequestThinkingConfig = {
  mode: "auto" | "off" | "effort";
  enabled?: boolean;
  effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  includeReasoning?: boolean;
};

type ActiveThreadRun = {
  id?: string;
  idempotencyKey: string;
  status: "queued" | "running" | "cancel_requested";
  mode?: "send" | "refresh" | "edit";
  userMessageId?: string | null;
  assistantMessageId?: string | null;
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

type ApiErrorPayload = {
  code?: unknown;
  message?: unknown;
};

class StreamRequestError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(input: { status: number; code?: string | null; message: string }) {
    super(input.message);
    this.name = "StreamRequestError";
    this.status = input.status;
    this.code = input.code ?? null;
  }
}

function getReadableStreamRequestError(input: {
  status: number;
  code?: string | null;
  message?: string | null;
}) {
  if (input.code === "CHAT_RUN_ALREADY_ACTIVE") {
    return "A response is already running for this chat.";
  }
  if (input.code === "CHAT_RUN_START_FAILED") {
    return "The response failed before it started. Please try again.";
  }

  return (
    input.message?.trim() ||
    (input.status === 409
      ? "This chat is already handling another request."
      : `Request failed (${input.status}).`)
  );
}

async function throwStreamRequestError(response: Response): Promise<never> {
  const payload = (await response.json().catch(() => null)) as
    | ApiErrorPayload
    | null;
  const code = typeof payload?.code === "string" ? payload.code : null;
  const message = typeof payload?.message === "string" ? payload.message : null;
  throw new StreamRequestError({
    status: response.status,
    code,
    message: getReadableStreamRequestError({
      status: response.status,
      code,
      message,
    }),
  });
}

function formatBytes(sizeBytes: number) {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024)
    return `${Math.round(sizeBytes / 102.4) / 10} KB`;
  return `${Math.round(sizeBytes / 1024 / 102.4) / 10} MB`;
}

function basename(path: string) {
  const cleaned = path.replace(/\/+$/, "");
  return cleaned.split("/").pop() || cleaned || path;
}

function workfilePurposeLabel(purpose: WorkfileDetail["purpose"]) {
  if (purpose === "scratch") return "Scratch";
  if (purpose === "draft") return "Draft";
  if (purpose === "note") return "Note";
  if (purpose === "output_candidate") return "Candidate";
  return "Workfile";
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

function normalizeThreadCommandRequest(
  value: unknown,
): ChatSendInput["command"] | undefined {
  const record = toObjectRecord(value);
  const name = toNullableString(record?.name)?.trim();
  if (!name) {
    return undefined;
  }

  const rawKind = toNullableString(record?.kind);
  const kind =
    rawKind === "tool" || rawKind === "skill" || rawKind === "skill-command"
      ? rawKind
      : undefined;
  const args = toNullableString(record?.arguments);
  const displayName = toNullableString(record?.displayName)?.trim();
  const skillSlug = toNullableString(record?.skillSlug)?.trim();
  const commandName = toNullableString(record?.commandName)?.trim();
  const toolName = toNullableString(record?.toolName)?.trim();
  const path = toNullableString(record?.path)?.trim();

  return {
    name,
    ...(kind ? { kind } : {}),
    ...(args !== null ? { arguments: args } : {}),
    ...(displayName ? { displayName } : {}),
    ...(skillSlug ? { skillSlug } : {}),
    ...(commandName ? { commandName } : {}),
    ...(toolName ? { toolName } : {}),
    ...(path ? { path } : {}),
  };
}

function createDurableRunKey() {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${SOURCEWEFT_WEB_RUN_IDEMPOTENCY_PREFIX}${random}`;
}

function resolveThreadRunMetadata(metadata: Record<string, unknown>) {
  const threadRun = toObjectRecord(metadata.threadRun);
  const idempotencyKey = toNullableString(threadRun?.idempotencyKey);
  const status = toNullableString(threadRun?.status);
  if (
    !idempotencyKey?.startsWith(SOURCEWEFT_WEB_RUN_IDEMPOTENCY_PREFIX) ||
    (status !== "queued" &&
      status !== "running" &&
      status !== "cancel_requested")
  ) {
    return null;
  }

  const mode = toNullableString(threadRun?.mode);
  return {
    id: toNullableString(threadRun?.id) ?? undefined,
    idempotencyKey,
    status,
    mode:
      mode === "send" || mode === "refresh" || mode === "edit"
        ? mode
        : undefined,
  } satisfies ActiveThreadRun;
}

function findLatestActiveThreadRunMessage(messages: ChatMessageItem[]) {
  for (const message of [...messages].reverse()) {
    if (message.role !== "assistant") {
      continue;
    }

    const run = resolveThreadRunMetadata(message.metadata);
    if (run) {
      return { message, run };
    }
  }

  return null;
}

function createActiveThreadRunPlaceholder(input: {
  run: ActiveThreadRun;
  latestUserMessageId: string | null;
}) {
  return {
    id: input.run.assistantMessageId ?? `pending-assistant-${input.run.id}`,
    role: "assistant" as const,
    content: "",
    contentJson: {},
    parentMessageId: null,
    metadata: {
      userMessageId: input.run.userMessageId ?? input.latestUserMessageId,
      sourceUserMessageId: input.run.userMessageId ?? input.latestUserMessageId,
      toolCalls: [],
      thinkingSteps: [],
      renderBlocks: [],
      threadRun: {
        id: input.run.id,
        idempotencyKey: input.run.idempotencyKey,
        status: input.run.status,
        mode: input.run.mode,
      },
    },
    createdAt: new Date().toISOString(),
  } satisfies ChatMessageItem;
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

function resolveMessageMentionedSourceIds(message: ChatMessageItem) {
  const rawSourceIds = message.metadata.mentionedSourceIds;
  if (!Array.isArray(rawSourceIds)) {
    return [] as string[];
  }

  return rawSourceIds.filter(
    (sourceId): sourceId is string => typeof sourceId === "string",
  );
}

function resolveMessageEffectiveMentionedSourceIds(message: ChatMessageItem) {
  const rawSourceIds = message.metadata.effectiveMentionedSourceIds;
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
  command?: unknown;
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
  text?: string;
  toolCall?: unknown;
  step?: unknown;
  citations?: unknown;
  availableCitations?: unknown;
  threadId?: string;
  title?: string;
  jobId?: string;
  mentionedSourceIds?: unknown;
  effectiveMentionedSourceIds?: unknown;
  sourceIds?: unknown;
  effectiveSourceIds?: unknown;
  contentJson?: unknown;
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
      input.event.type === "tool-call-end" &&
      eventOutput === null &&
      normalizedToolOutput === null &&
      existing?.status === "completed"
    ) {
      return existing?.output ?? null;
    }

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

    if (normalizedToolCall && input.event.type !== "tool-call-event") {
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

function getToolCallPath(value: Record<string, unknown>) {
  for (const key of ["path", "file_path", "filePath"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return null;
}

function isWorkPath(value: string | null | undefined) {
  return value === "/work" || Boolean(value?.startsWith("/work/"));
}

function outputContainsWorkPath(output: unknown) {
  const record = toObjectRecord(output);
  if (!record) {
    return false;
  }

  if (isWorkPath(getToolCallPath(record))) {
    return true;
  }

  const content = toNullableString(record.content);
  return Boolean(content?.includes("/work/"));
}

function isCompletedWorkfileWriteToolCall(
  toolCall: ToolCallRecord,
  event: StreamEventPayload & { type: ToolCallEventType },
) {
  if (
    event.type !== "tool-call-result" &&
    !(event.type === "tool-call-end" && toolCall.status === "completed")
  ) {
    return false;
  }

  if (!isWorkfileWriteToolName(toolCall.tool)) {
    return false;
  }

  return (
    isWorkPath(getToolCallPath(toolCall.input)) ||
    outputContainsWorkPath(toolCall.output)
  );
}

function isCompletedImageArtifactToolCall(
  toolCall: ToolCallRecord,
  event: StreamEventPayload & { type: ToolCallEventType },
) {
  return (
    isGeneratedImageArtifactToolName(toolCall.tool) &&
    (event.type === "tool-call-result" ||
      (event.type === "tool-call-end" && toolCall.status === "completed"))
  );
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

function normalizeMessageRenderBlock(
  value: unknown,
): MessageRenderBlock | null {
  const record = toObjectRecord(value);
  if (!record) {
    return null;
  }

  const id = toNullableString(record.id);
  if (!id) {
    return null;
  }

  if (record.type === "text") {
    const text = toNullableString(record.text);
    return text && text.length > 0
      ? {
          id,
          type: "text",
          text,
        }
      : null;
  }

  if (record.type === "generated_image") {
    const toolCallId = toNullableString(record.toolCallId);
    return toolCallId
      ? {
          id,
          type: "generated_image",
          toolCallId,
        }
      : null;
  }

  return null;
}

function resolveRenderBlocksFromMetadata(metadata: Record<string, unknown>) {
  if (!Array.isArray(metadata.renderBlocks)) {
    return [] as MessageRenderBlock[];
  }

  return metadata.renderBlocks
    .map((item) => normalizeMessageRenderBlock(item))
    .filter((item): item is MessageRenderBlock => item !== null);
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

    const sourceUserMessageId = assistantSourceUserById.get(rootMessage.id);
    const sourceUserRootId =
      sourceUserMessageId && messageById.has(sourceUserMessageId)
        ? resolveRootId(messageById.get(sourceUserMessageId)!)
        : null;
    const sourceTurn = sourceUserRootId
      ? [...turns]
          .reverse()
          .find((turn) => turn.userRootId === sourceUserRootId)
      : null;
    if (sourceTurn) {
      const existingAssistant = sourceTurn.assistantRootId
        ? messageById.get(sourceTurn.assistantRootId)
        : null;
      if (
        !existingAssistant ||
        (existingAssistant.metadata.isError === true &&
          rootMessage.metadata.isError !== true)
      ) {
        sourceTurn.assistantRootId = rootMessage.id;
      }
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

  const assistantRootBySourceUserId = new Map<string, string>();
  for (const message of sorted) {
    if (message.role !== "assistant") {
      continue;
    }

    const sourceUserMessageId = assistantSourceUserById.get(message.id);
    if (!sourceUserMessageId || !messageById.has(sourceUserMessageId)) {
      continue;
    }

    const sourceUserMessage = messageById.get(sourceUserMessageId);
    if (!sourceUserMessage) {
      continue;
    }

    const sourceUserRootId = resolveRootId(sourceUserMessage);
    const rootId = resolveRootId(message);
    const existingRootId = assistantRootBySourceUserId.get(sourceUserRootId);
    if (!existingRootId) {
      assistantRootBySourceUserId.set(sourceUserRootId, rootId);
      continue;
    }

    const existing = messageById.get(existingRootId);
    const candidate = messageById.get(rootId);
    if (
      existing?.metadata.isError === true &&
      candidate?.metadata.isError !== true
    ) {
      assistantRootBySourceUserId.set(sourceUserRootId, rootId);
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
    const sourceUserMessageId =
      message.role === "assistant"
        ? assistantSourceUserById.get(message.id)
        : null;
    const sourceUserRootId =
      sourceUserMessageId && messageById.has(sourceUserMessageId)
        ? resolveRootId(messageById.get(sourceUserMessageId)!)
        : null;
    const rootId =
      message.role === "assistant" && sourceUserRootId
        ? (assistantRootBySourceUserId.get(sourceUserRootId) ??
          resolveRootId(message))
        : resolveRootId(message);
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
            renderKey:
              toNullableString(version.metadata[STREAM_RENDER_KEY]) ??
              undefined,
            content: version.content,
            contentJson: version.contentJson,
            command:
              group.role === "user"
                ? ((toObjectRecord(version.metadata.command) ??
                    undefined) as ChatSendInput["command"] | undefined)
                : undefined,
            citations: citationMetadata?.citations,
            availableCitations: citationMetadata?.availableCitations,
            isError: version.metadata.isError === true,
            isCancelled:
              version.metadata.isCancelled === true ||
              version.metadata.errorCode === "CLIENT_CANCELLED" ||
              toObjectRecord(version.metadata.threadRun)?.status ===
                "cancelled",
            error: toNullableString(version.metadata.error),
            errorCode: toNullableString(version.metadata.errorCode),
            isTextPaused: version.metadata[STREAM_TEXT_PAUSED_KEY] === true,
            isTextInterrupted:
              version.metadata[STREAM_TEXT_INTERRUPTED_KEY] === true,
            mentionedSourceIds:
              group.role === "user"
                ? resolveMessageMentionedSourceIds(version)
                : undefined,
            effectiveMentionedSourceIds:
              group.role === "user"
                ? resolveMessageEffectiveMentionedSourceIds(version)
                : undefined,
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
            renderBlocks:
              group.role === "assistant"
                ? resolveRenderBlocksFromMetadata(version.metadata)
                : undefined,
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
  const router = useRouter();
  const { threadId } = use(params);

  const {
    privateChats,
    sourcesVisible,
    startNewChat,
    switchWorkspace,
    toggleSourcesVisible,
    updateChatTitle,
    updateChatSourceCount,
    workspaceId,
    workspaceName,
    workspaces,
  } = useDashboardChatState();

  // ── Thread metadata from sidebar list ─────────────────────────────────────
  const chatItem = privateChats.find((c) => c.id === threadId);
  const threadTitle = chatItem?.title ?? "Chat";

  // ── Messaging state ────────────────────────────────────────────────────────
  const [messages, setMessages] = useState<ChatMessageItem[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [activeThreadRun, setActiveThreadRun] =
    useState<ActiveThreadRun | null>(null);
  const activeThreadRunRef = useRef<ActiveThreadRun | null>(null);
  const attachedRunKeyRef = useRef<string | null>(null);
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
  const [previewSource, setPreviewSource] = useState<SourceItem | null>(null);
  const [previewWorkfile, setPreviewWorkfile] = useState<WorkfileDetail | null>(
    null,
  );
  const [previewArtifact, setPreviewArtifact] =
    useState<ArtifactListItem | null>(null);
  const isDesktopPanel = useMediaQuery("(min-width: 1024px)");
  const [workfilesRefreshKey, setWorkfilesRefreshKey] = useState(0);
  const [artifactsRefreshKey, setArtifactsRefreshKey] = useState(0);
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

  useEffect(() => {
    activeThreadRunRef.current = activeThreadRun;
  }, [activeThreadRun]);

  useEffect(() => {
    if (!workspaceId) {
      setLoadedByokStorageKey(null);
      setSelectedByokModels({});
      return;
    }
    const stored = readStoredByokState(workspaceId, threadId);
    setLoadedByokStorageKey(`${workspaceId}:${threadId}`);
    setSelectedByokModels({
      image: stored?.imageByok ?? null,
      llm: stored?.llmByok ?? null,
      vision: stored?.visionByok ?? null,
    });
  }, [threadId, workspaceId]);

  // ── Sources state ──────────────────────────────────────────────────────────
  const [librarySources, setLibrarySources] = useState<SourceItem[]>([]);
  const [activeSourceIds, setActiveSourceIds] = useState<string[]>([]);
  const [availableSkills, setAvailableSkills] = useState<ChatSkillItem[]>([]);
  const [activeSkillIds, setActiveSkillIds] = useState<string[]>([]);
  const [disabledToolNames, setDisabledToolNames] = useState<ChatToolName[]>([]);
  const skillsLoadGenerationRef = useRef(0);
  const [selectionLoaded, setSelectionLoaded] = useState(false);
  const initialSourcesForWorkspace = useMemo(
    () => getCachedWorkspaceSources(workspaceId) ?? librarySources,
    [librarySources, workspaceId],
  );

  // ── Composer state ─────────────────────────────────────────────────────────
  const [composerInitialInput, setComposerInitialInput] = useState("");
  const [composerInitialCommand, setComposerInitialCommand] = useState<
    ChatSendInput["command"] | null
  >(null);
  const [composerResetKey, setComposerResetKey] = useState(0);
  const [selectedModels, setSelectedModels] = useState<SelectedModels>(() =>
    resolveSelectedModels({ availableModels: emptyModelCatalog }),
  );
  const [baseSelectedModels, setBaseSelectedModels] = useState<SelectedModels>(
    () => resolveSelectedModels({ availableModels: emptyModelCatalog }),
  );
  const [modelSelectionSources, setModelSelectionSources] =
    useState<ModelSelectionSources>(DEFAULT_MODEL_SELECTION_SOURCES);
  const [availableModels, setAvailableModels] =
    useState<Record<ModelType, ModelItem[]>>(emptyModelCatalog);
  const [byokProviders, setByokProviders] = useState<ByokProviderOption[]>([]);
  const [byokCredentials, setByokCredentials] = useState<ByokCredentialItem[]>([]);
  const [byokModels, setByokModels] = useState<ByokSavedModelItem[]>([]);
  const [selectedByokModels, setSelectedByokModels] = useState<
    Partial<Record<ModelType, ByokModelSelection | null>>
  >({});
  const [loadedByokStorageKey, setLoadedByokStorageKey] = useState<
    string | null
  >(null);
  const [byokModelConfig, setByokModelConfig] =
    useState<ByokModelConfigDefaults | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const shortcutPlatform = useDashboardShortcutPlatform();
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

  useEffect(() => {
    setLibrarySources(getCachedWorkspaceSources(workspaceId) ?? []);
  }, [workspaceId]);

  const loadSourceMentions = useCallback<PromptInputMentionSourceLoader>(
    async ({ cursor, limit, query }) => {
      if (!workspaceId) {
        return { items: [], nextCursor: null };
      }

      const result = await contentClient.listSourceMentions(workspaceId, {
        cursor: cursor ?? undefined,
        limit,
        query: query || undefined,
      });
      return {
        items: result.items.map((source) => ({
          id: source.id,
          meta:
            source.status === "failed"
              ? "Processing failed"
              : source.status === "queued" || source.status === "processing"
                ? "Sync in progress"
                : new Date(source.updatedAt).toLocaleString(),
          title: source.title || "Untitled",
          type: source.mimeType ?? source.sourceType,
        })),
        nextCursor: result.nextCursor,
      };
    },
    [workspaceId],
  );

  const clearEditingState = useCallback(() => {
    setEditingMessageId(null);
    setEditingAssistantMessageId(null);
    setEditingGroupId(null);
    setEditingBranchIndex(null);
  }, []);

  const cancelEditing = useCallback(() => {
    clearEditingState();
    setComposerInitialInput("");
    setComposerInitialCommand(null);
    setComposerResetKey((value) => value + 1);
  }, [clearEditingState]);

  useEffect(() => {
    if (!desktopBridge.isAvailable()) {
      return;
    }

    const cleanupTask = desktopBridge.onDeepLink((payload) => {
      const url = payload.url.trim();
      if (!url) {
        return;
      }

      void handleDesktopAuthDeepLink({
        url,
        onSuccess: () => {
          router.replace("/dashboard");
          router.refresh();
        },
        onError: (message) => toast.error(message),
      }).then((handled) => {
        if (handled) {
          return;
        }
      });
    });

    return () => {
      cleanupTask.then((cleanup) => void cleanup()).catch(() => {});
    };
  }, [router]);

  useEffect(() => {
    setThinkingSettings((current) =>
      normalizeThinkingSettingsForModel({
        capabilities: selectedModels.llm?.capabilities,
        hasSavedPreference: hasSavedThinkingPreference,
        settings: current,
      }),
    );
  }, [hasSavedThinkingPreference, selectedModels.llm]);

  useEffect(() => {
    if (!workspaceId) {
      setLoadedByokStorageKey(null);
      return;
    }
    if (loadedByokStorageKey !== `${workspaceId}:${threadId}`) {
      return;
    }
    writeStoredByokState(
      workspaceId,
      {
        imageByok: selectedByokModels.image ?? null,
        llmByok: selectedByokModels.llm ?? null,
        visionByok: selectedByokModels.vision ?? null,
      },
      threadId,
    );
  }, [loadedByokStorageKey, selectedByokModels, threadId, workspaceId]);

  useEffect(() => {
    if (!workspaceId) {
      return;
    }
    if (
      !selectedModels.llm &&
      !selectedModels.image &&
      !selectedModels.vision &&
      !selectedByokModels.llm &&
      !selectedByokModels.image &&
      !selectedByokModels.vision
    ) {
      return;
    }

    writeStoredModelSelection(workspaceId, threadId, {
      llmProfileAlias:
        selectedByokModels.llm?.mode === "byok"
          ? null
          : (selectedModels.llm?.profileAlias ?? selectedModels.llm?.id ?? null),
      imageProfileAlias:
        selectedByokModels.image?.mode === "byok"
          ? null
          : (selectedModels.image?.profileAlias ??
            selectedModels.image?.id ??
            null),
      visionProfileAlias:
        selectedByokModels.vision?.mode === "byok"
          ? null
          : (selectedModels.vision?.profileAlias ??
            selectedModels.vision?.id ??
            null),
    });
  }, [selectedByokModels, selectedModels, threadId, workspaceId]);

  const effectiveActiveSkillIds = useMemo(
    () =>
      removeDisabledToolSkills({
        skillIds: activeSkillIds,
        availableSkills,
        disabledToolNames,
      }),
    [activeSkillIds, availableSkills, disabledToolNames],
  );

  useEffect(() => {
    if (selectedByokModels.llm?.mode === "byok") {
      return;
    }
    const next = applySkillModelPresetState({
      activeSkillIds: effectiveActiveSkillIds,
      availableModels,
      availableSkills,
      baseSelectedModels,
      selectedModels,
      selectionSources: modelSelectionSources,
    });
    if (next.modelsChanged) {
      setSelectedModels(next.nextModels);
      if (next.nextSources.llm === "skill" && catalogKindEnabled.llm) {
        setStreamWithSelectedLlm(true);
      }
    }
    if (next.sourcesChanged) {
      setModelSelectionSources(next.nextSources);
      if (
        next.nextSources.llm === "system" &&
        modelSelectionSources.llm === "skill"
      ) {
        setStreamWithSelectedLlm(catalogKindEnabled.llm);
      }
    }
  }, [
    effectiveActiveSkillIds,
    availableModels,
    availableSkills,
    baseSelectedModels,
    catalogKindEnabled.llm,
    modelSelectionSources,
    selectedByokModels.llm,
    selectedModels,
  ]);

  // Tracks whether initial bootstrap was already processed for this thread key.
  const bootstrappedThreadKeyRef = useRef<string | null>(null);

  // ── Local storage: persist selected source IDs per thread ───────────────
  const selectionStorageKey = useMemo(
    () =>
      workspaceId ? getSourceSelectionStorageKey(workspaceId, threadId) : null,
    [workspaceId, threadId],
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
    if (!workspaceId) {
      setActiveSourceIds([]);
      setSelectionLoaded(true);
      return;
    }
    setActiveSourceIds(readStoredSourceSelection(workspaceId, threadId));
    setSelectionLoaded(true);
  }, [selectionStorageKey, threadId, workspaceId]);

  const persistActiveSourceIds = useCallback(
    (sourceIds: string[]) => {
      setActiveSourceIds(sourceIds);
      if (workspaceId) {
        writeStoredSourceSelection(workspaceId, threadId, sourceIds);
      }
    },
    [threadId, workspaceId],
  );

  useEffect(() => {
    if (!selectionLoaded || !workspaceId) return;
    writeStoredSourceSelection(workspaceId, threadId, activeSourceIds);
  }, [
    activeSourceIds,
    selectionLoaded,
    selectionStorageKey,
    threadId,
    workspaceId,
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

  const handleLibrarySourcesLoad = useCallback(
    (sources: SourceItem[]) => {
      setCachedWorkspaceSources(workspaceId, sources);
      setLibrarySources(sources);
    },
    [workspaceId],
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

  const loadAvailableSkills = useCallback(async () => {
    const loadGeneration = ++skillsLoadGenerationRef.current;
    if (!workspaceId) {
      setAvailableSkills([]);
      setActiveSkillIds([]);
      return;
    }

    const activeWorkspaceId = workspaceId;
    try {
      const result = await contentClient.listSkillsCatalog(activeWorkspaceId);
      if (
        skillsLoadGenerationRef.current !== loadGeneration ||
        activeWorkspaceId !== workspaceId
      ) {
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
          capabilities: skill.capabilities,
          models: skill.models,
          tools: skill.tools,
          slash: skill.slash,
          slashConfig: skill.slashConfig,
          commands: skill.commands,
          defaultConfig: skill.defaultConfig,
        }));
      setAvailableSkills(enabledSkills);

      const enabledIds = new Set(enabledSkills.map((skill) => skill.id));
      setActiveSkillIds((current) =>
        current.filter((id) => enabledIds.has(id)).slice(0, 5),
      );
    } catch {
      if (skillsLoadGenerationRef.current !== loadGeneration) {
        return;
      }
      setAvailableSkills([]);
      setActiveSkillIds([]);
    }
  }, [workspaceId]);

  useEffect(() => {
    void loadAvailableSkills();
  }, [loadAvailableSkills]);

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
      setPreviewSource(null);
      setPreviewWorkfile(null);
      setPreviewCitation(citation);
      if (!sourcesVisible) {
        toggleSourcesVisible();
      }
    },
    [displayedCitations, sourcesVisible, toggleSourcesVisible],
  );

  const handleArtifactPreview = useCallback(
    (artifact: ArtifactPreviewRecord) => {
      setPreviewSource(null);
      setPreviewWorkfile(null);
      setPreviewCitation(null);
      setPreviewArtifact(artifact);
      if (!sourcesVisible) {
        toggleSourcesVisible();
      }
    },
    [sourcesVisible, toggleSourcesVisible],
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
      setPreviewSource(null);
      setPreviewWorkfile(null);
      setPreviewCitation(citation);
      if (context?.messageId) {
        scrollToMessage(context.messageId);
      }
    },
    [scrollToMessage],
  );

  const handleSourcePreview = useCallback((source: SourceItem) => {
    setPreviewCitation(null);
    setPreviewWorkfile(null);
    setPreviewSource(source);
  }, []);

  const handleWorkfilePreview = useCallback(
    async (path: string) => {
      if (!workspaceId || !threadId) {
        toast.error("No thread workspace selected.");
        return;
      }

      try {
        const result = await contentClient.getWorkingFile(
          workspaceId,
          threadId,
          path,
        );
        setPreviewCitation(null);
        setPreviewSource(null);
        setPreviewWorkfile(result.file);
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to load workfile.",
        );
      }
    },
    [threadId, workspaceId],
  );

  useEffect(() => {
    setActiveCitationIndex(null);
    setPreviewCitation(null);
    setPreviewSource(null);
    setPreviewWorkfile(null);
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
          group.groupId === pendingSelection?.assistantGroupId ||
          (group.role === "assistant" &&
            group.turnId &&
            group.turnId === pendingSelection?.turnId)
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
          appliedPendingGroups.has(pendingSelection.assistantGroupId)) &&
        (!pendingSelection.turnId ||
          messageGroups.some(
            (group) =>
              group.role === "assistant" &&
              group.turnId === pendingSelection.turnId &&
              appliedPendingGroups.has(group.groupId),
          ))
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
        const [messagesResult, activeRunResult] = await Promise.all([
          contentClient.listThreadMessages(workspaceId, threadId),
          contentClient.getActiveThreadRun(workspaceId, threadId),
        ]);
        let serverMessages = messagesResult.items
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
            contentJson: message.contentJson,
            parentMessageId: message.parentMessageId,
            metadata: message.metadata,
            createdAt: message.createdAt,
          }))
          .sort(
            (left, right) =>
              new Date(left.createdAt).getTime() -
              new Date(right.createdAt).getTime(),
          );
        const activeRun = activeRunResult.threadRun;

        if (threadMessagesLoadGenerationRef.current !== loadGeneration) {
          return;
        }

        loadedThreadMessagesKeyRef.current = threadMessagesKey;
        let runningAssistant = findLatestActiveThreadRunMessage(serverMessages);
        const runningRun = runningAssistant?.run ?? activeRun;
        if (runningRun && !runningAssistant) {
          const latestUserMessage = [...serverMessages]
            .reverse()
            .find((message) => message.role === "user");
          const placeholder = createActiveThreadRunPlaceholder({
            run: runningRun,
            latestUserMessageId: latestUserMessage?.id ?? null,
          });
          serverMessages = [...serverMessages, placeholder];
          runningAssistant = { message: placeholder, run: runningRun };
        }
        setActiveThreadRun(runningRun);
        setMessages(serverMessages);
        if (
          runningRun &&
          runningAssistant &&
          runningRun.idempotencyKey !== attachedRunKeyRef.current
        ) {
          attachedRunKeyRef.current = runningRun.idempotencyKey;
          void streamThreadActionRef.current({
            mode: runningRun.mode ?? "send",
            durableRunKey: runningRun.idempotencyKey,
            attachOnly: true,
            assistantMessageId: runningAssistant.message.id,
            baseMessages: serverMessages,
          });
        }
        return;
      } catch (error) {
        if (threadMessagesLoadGenerationRef.current !== loadGeneration) {
          return;
        }

        const retryDelay = THREAD_MESSAGES_LOAD_RETRY_DELAYS_MS[attempt];
        if (retryDelay === undefined || !shouldRetryThreadMessagesLoad(error)) {
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
      const emptySelection = resolveSelectedModels({
        availableModels: emptyModelCatalog,
      });
      setSelectedModels(emptySelection);
      setBaseSelectedModels(emptySelection);
      setModelSelectionSources(DEFAULT_MODEL_SELECTION_SOURCES);
      setCatalogKindEnabled(EMPTY_MODEL_KIND_FLAGS);
      setByokProviders([]);
      setByokCredentials([]);
      setByokModels([]);
      setSelectedByokModels({});
      setStreamWithSelectedLlm(false);
      return;
    }

    setStreamWithSelectedLlm(false);
    const stored = readStoredByokState(workspaceId, threadId);
    const storedByokSelections = {
      image: stored?.imageByok ?? null,
      llm: stored?.llmByok ?? null,
      vision: stored?.visionByok ?? null,
    } satisfies Partial<Record<ModelType, ByokModelSelection | null>>;

    try {
      const [
        catalog,
        threadResponse,
        providerResult,
        credentialResult,
        modelResult,
      ] = await Promise.all([
        contentClient.listThreadModelCatalog(workspaceId),
        contentClient.getThread(workspaceId, threadId),
        contentClient.listByokProviders(workspaceId).catch(() => []),
        contentClient.listByokCredentials(workspaceId).catch(() => ({
          items: [],
        })),
        contentClient.listByokModels(workspaceId).catch(() => ({
          items: [],
        })),
      ]);

      const catalogModels = mapCatalogKindsToModelItems(catalog.kinds);
      const kindEnabled = {
        llm: catalogModels.llm.length > 0,
        image: catalogModels.image.length > 0,
        vision: catalogModels.vision.length > 0,
      } satisfies Record<ModelType, boolean>;

      setCatalogKindEnabled(kindEnabled);
      setAvailableModels(catalogModels);
      const resolvedModels = resolveSelectedModels({
        availableModels: catalogModels,
        threadAliases: threadResponse.thread.modelSettings,
        fallbackAliases: catalog.defaults,
      });
      setSelectedModels(
        resolveSelectedModelsWithByok({
          availableModels: catalogModels,
          baseSelectedModels: resolvedModels,
          byokSelections: storedByokSelections,
        }),
      );
      setBaseSelectedModels(resolvedModels);
      setModelSelectionSources(DEFAULT_MODEL_SELECTION_SOURCES);
      setByokCredentials(credentialResult.items);
      setByokModels(modelResult.items);
      setSelectedByokModels(storedByokSelections);
      setByokProviders(
        normalizeByokProviderOptions(providerResult, credentialResult.items),
      );
      setStreamWithSelectedLlm(kindEnabled.llm);
    } catch {
      setCatalogKindEnabled(EMPTY_MODEL_KIND_FLAGS);
      setAvailableModels(emptyModelCatalog);
      const emptySelection = resolveSelectedModels({
        availableModels: emptyModelCatalog,
      });
      setSelectedModels(emptySelection);
      setBaseSelectedModels(emptySelection);
      setModelSelectionSources(DEFAULT_MODEL_SELECTION_SOURCES);
      setByokProviders([]);
      setByokCredentials([]);
      setByokModels([]);
      setSelectedByokModels({});
      setStreamWithSelectedLlm(false);
    }
  }, [threadId, workspaceId]);

  useEffect(() => {
    void loadThreadModelState();
  }, [loadThreadModelState]);

  const handleModelSelect = useCallback(
    async (input: { type: ModelType; model: ModelItem }) => {
      setModelSelectionSources((current) => ({
        ...current,
        [input.type]: "user",
      }));
      setSelectedByokModels((current) => ({
        ...current,
        [input.type]: null,
      }));
      if (!workspaceId || !catalogKindEnabled[input.type]) {
        return;
      }

      const patch: ModelAliasSettings =
        input.type === "llm"
          ? { llmProfileAlias: input.model.profileAlias ?? input.model.id }
          : input.type === "image"
            ? { imageProfileAlias: input.model.profileAlias ?? input.model.id }
            : { visionProfileAlias: input.model.profileAlias ?? input.model.id };

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
      mentionedSourceIds?: string[];
      sourceIds?: string[];
      skillIds?: string[];
      tools?: ChatSendInput["tools"];
      images?: ChatSendInput["images"];
      command?: ChatSendInput["command"];
      userMessageId?: string | null;
      assistantMessageId?: string | null;
      thinking?: RequestThinkingConfig;
      searchEnabled?: boolean;
      byokSelections?: Partial<Record<ModelType, ByokModelSelection | null>>;
      durableRunKey?: string;
      attachOnly?: boolean;
      baseMessages?: ChatMessageItem[];
    }) => {
      if (!workspaceId) {
        return;
      }

      setIsStreaming(true);
      const durableRunKey = input.durableRunKey ?? createDurableRunKey();
      setActiveThreadRun({
        idempotencyKey: durableRunKey,
        status: "running",
        mode: input.mode,
      });
      clearEditingState();

      const now = Date.now();
      const messageSnapshot = input.baseMessages ?? messages;
      const latestUserMessage = [...messageSnapshot]
        .reverse()
        .find((message) => message.role === "user");
      const latestAssistantMessage = [...messageSnapshot]
        .reverse()
        .find((message) => message.role === "assistant");

      const temporaryMessages: ChatMessageItem[] = [];
      let tempUserId: string | null = null;
      const temporaryImageParts =
        input.images?.map((image, index) => ({
          type: "image" as const,
          id: `temp-image-${now}-${index}`,
          fileName: image.fileName ?? `image-${index + 1}`,
          mimeType: image.mimeType ?? "image/png",
          sizeBytes: image.sizeBytes ?? 0,
          width: image.width ?? null,
          height: image.height ?? null,
          url: image.dataUrl,
        })) ?? [];

      if (
        !input.attachOnly &&
        (input.mode === "send" || input.mode === "edit")
      ) {
        tempUserId = `temp-user-${now}`;
        const localEffectiveSourceIds = expandSelectedSources(
          librarySources,
          input.sourceIds ?? [],
        ).map((source) => source.id);
        temporaryMessages.push({
          id: tempUserId,
          role: "user",
          content: input.content ?? "",
          contentJson: {
            version: 1,
            parts: [
              ...(input.content?.trim()
                ? [{ type: "text" as const, text: input.content }]
                : []),
              ...temporaryImageParts,
            ],
          },
          parentMessageId:
            input.mode === "edit"
              ? (input.userMessageId ?? latestUserMessage?.id ?? null)
              : null,
          metadata: {
            ...(input.mentionedSourceIds && input.mentionedSourceIds.length > 0
              ? { mentionedSourceIds: input.mentionedSourceIds }
              : {}),
            ...(input.mentionedSourceIds && input.mentionedSourceIds.length > 0
              ? { effectiveMentionedSourceIds: input.mentionedSourceIds }
              : {}),
            ...(input.sourceIds ? { sourceIds: input.sourceIds } : {}),
            ...(localEffectiveSourceIds.length > 0
              ? { effectiveSourceIds: localEffectiveSourceIds }
              : {}),
            skillIds: input.skillIds ?? [],
            tools: buildChatToolsRequest({
              imageExecution:
                selectedByokModels.image?.mode === "byok"
                  ? buildByokModelExecution({
                      selection: selectedByokModels.image,
                    })
                  : null,
              invokedSkillIds: input.tools?.invokedSkillIds,
              skillIds: input.skillIds ?? [],
              searchEnabled: input.searchEnabled ?? searchEnabled,
              tools: input.tools,
              forceImageGenerate:
                input.command?.kind === "tool" &&
                input.command.name === `/${AGENT_TOOL_NAMES.generateImage}`,
            }),
            ...(input.command ? { command: input.command } : {}),
            versionOf:
              input.mode === "edit"
                ? (input.userMessageId ?? latestUserMessage?.id ?? null)
                : null,
          },
          createdAt: new Date(now).toISOString(),
        });
      }

      const tempAssistantId = `temp-assistant-${now + 1}`;
      const tempAssistantRenderKey = tempAssistantId;
      if (!input.attachOnly) {
        temporaryMessages.push({
          id: tempAssistantId,
          role: "assistant",
          content: "",
          contentJson: {},
          parentMessageId:
            input.mode === "send"
              ? null
              : (input.assistantMessageId ??
                latestAssistantMessage?.id ??
                null),
          metadata: {
            userMessageId:
              tempUserId ??
              input.userMessageId ??
              latestUserMessage?.id ??
              null,
            versionOf:
              input.mode === "send"
                ? null
                : (input.assistantMessageId ??
                  latestAssistantMessage?.id ??
                  null),
            toolCalls: [],
            thinkingSteps: [],
            renderBlocks: [],
            threadRun: {
              idempotencyKey: durableRunKey,
              status: "running",
              mode: input.mode,
            },
            [STREAM_RENDER_KEY]: tempAssistantRenderKey,
          },
          createdAt: new Date(now + 1).toISOString(),
        });
      }

      if (temporaryMessages.length > 0) {
        setMessages((previous) => [...previous, ...temporaryMessages]);
      }

      if (!input.attachOnly && input.mode !== "refresh") {
        setComposerInitialInput("");
        setComposerResetKey((value) => value + 1);
      }

      let persistedUserMessageId = tempUserId ?? input.userMessageId ?? null;
      let createdUserMessageId: string | null = tempUserId;
      let persistedAssistantMessageId: string | null = null;
      let hasServerPersistedAssistantMessage = false;
      let shouldPollThreadTitle = false;
      let pendingTitleJobId: string | null = null;
      const streamToolCallsById = new Map<string, ToolCallRecord>();
      const streamThinkingStepsById = new Map<string, ThinkingStepRecord>();
      const streamRenderBlocks: MessageRenderBlock[] = [];
      let nextStreamTextBlockId = 1;
      const refreshedWorkfileToolIds = new Set<string>();
      const refreshedArtifactToolIds = new Set<string>();
      let streamingAssistantMessageId = input.attachOnly
        ? (input.assistantMessageId ??
          latestAssistantMessage?.id ??
          tempAssistantId)
        : tempAssistantId;
      let preparedEffectiveSourceIds: string[] | null = null;
      let buffer = "";
      let assistantText = "";
      let latestAssistantMessageContent = "";
      let streamError: Error | null = null;
      let hasRenderedDelta = false;
      const deltaQueue: string[] = [];
      let streamEnded = false;
      let receivedFinishEvent = false;
      let detachedWithoutFinish = false;
      let drainPromise: Promise<void> | null = null;
      let suppressErrorToast = false;

      if (input.attachOnly && latestAssistantMessage) {
        assistantText = "";
        latestAssistantMessageContent = latestAssistantMessage.content;
        resolveToolCallsFromMetadata(latestAssistantMessage.metadata).forEach(
          (toolCall) => {
            streamToolCallsById.set(toolCall.id, toolCall);
          },
        );
        resolveThinkingStepsFromMetadata(latestAssistantMessage.metadata).forEach(
          (step) => {
            streamThinkingStepsById.set(step.id, step);
          },
        );
        streamRenderBlocks.push(
          ...resolveRenderBlocksFromMetadata(latestAssistantMessage.metadata),
        );
        nextStreamTextBlockId = streamRenderBlocks.length + 1;
      }

      const waitForAnimationFrame = () =>
        new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => resolve());
        });

      function appendStreamRenderText(text: string) {
        if (!text) {
          return;
        }
        const last = streamRenderBlocks[streamRenderBlocks.length - 1];
        if (last?.type === "text") {
          last.text += text;
          return;
        }
        streamRenderBlocks.push({
          id: `stream-text-${nextStreamTextBlockId}`,
          type: "text",
          text,
        });
        nextStreamTextBlockId += 1;
      }

      function appendStreamGeneratedImageBlock(toolCallId: string) {
        if (
          streamRenderBlocks.some(
            (block) =>
              block.type === "generated_image" &&
              block.toolCallId === toolCallId,
          )
        ) {
          return;
        }

        streamRenderBlocks.push({
          id: `stream-generated-image-${toolCallId}`,
          type: "generated_image",
          toolCallId,
        });
      }

      function snapshotStreamRenderBlocks() {
        return streamRenderBlocks.map((block) => ({ ...block }));
      }

      const syncLatestAssistantMessageContent = () => {
        setMessages((previous) => {
          const message = previous.find(
            (item) => item.id === streamingAssistantMessageId,
          );
          latestAssistantMessageContent = message?.content ?? assistantText;
          return previous;
        });
      };

      const drainQueuedDeltasNow = () => {
        if (deltaQueue.length === 0) {
          syncLatestAssistantMessageContent();
          return;
        }

        while (deltaQueue.length > 0) {
          const nextDelta = deltaQueue.shift() ?? "";
          assistantText += nextDelta;
          appendStreamRenderText(nextDelta);
        }
        latestAssistantMessageContent = assistantText;
        flushSync(() => {
          setMessages((previous) =>
            previous.map((message) =>
              message.id === streamingAssistantMessageId
                ? {
                    ...message,
                    content: assistantText,
                    metadata: {
                      ...message.metadata,
                      renderBlocks: snapshotStreamRenderBlocks(),
                      threadRun: {
                        ...(toObjectRecord(message.metadata.threadRun) ?? {}),
                        idempotencyKey: durableRunKey,
                        status: "running",
                        mode: input.mode,
                      },
                    },
                  }
                : message,
            ),
          );
        });
      };

      const markStreamingAssistantAsError = (errorInput: {
        code?: string | null;
        error: string;
        messageId?: string | null;
        parentMessageId?: string | null;
        parentMessageIdProvided?: boolean;
        serverPersisted?: boolean;
        userMessageId?: string | null;
      }) => {
        drainQueuedDeltasNow();
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
        }

        const previousAssistantMessageId = streamingAssistantMessageId;
        const messageId = errorInput.messageId || previousAssistantMessageId;
        const userMessageId =
          errorInput.userMessageId ?? persistedUserMessageId;
        const isClientCancelled = errorInput.code === "CLIENT_CANCELLED";
        persistedAssistantMessageId = messageId;
        hasServerPersistedAssistantMessage =
          errorInput.serverPersisted === true;
        streamingAssistantMessageId = messageId;
        flushSync(() => {
          setMessages((previous) =>
            previous.map((message) =>
              message.id === previousAssistantMessageId
                ? {
                    ...message,
                    id: messageId,
                    content: latestAssistantMessageContent,
                    parentMessageId:
                      errorInput.parentMessageIdProvided === true
                        ? (errorInput.parentMessageId ?? null)
                        : message.parentMessageId,
                    metadata: {
                      ...message.metadata,
                      isError: !isClientCancelled,
                      isCancelled: isClientCancelled,
                      excludeFromContext: true,
                      error: errorInput.error,
                      errorCode: errorInput.code ?? null,
                      userMessageId,
                      sourceUserMessageId: userMessageId,
                      [STREAM_TEXT_PAUSED_KEY]: false,
                      [STREAM_TEXT_INTERRUPTED_KEY]: false,
                      toolCalls: [...streamToolCallsById.values()].filter(
                        (toolCall) =>
                          shouldRenderToolCall(toolCall, [
                            ...streamThinkingStepsById.values(),
                          ]),
                      ),
                      thinkingSteps: [...streamThinkingStepsById.values()],
                      renderBlocks: snapshotStreamRenderBlocks(),
                      threadRun: {
                        ...(toObjectRecord(message.metadata.threadRun) ?? {}),
                        idempotencyKey: durableRunKey,
                        status: isClientCancelled ? "cancelled" : "failed",
                        mode: input.mode,
                      },
                    },
                  }
                : message,
            ),
          );
        });
      };

      try {
        const requestBody: Record<string, unknown> = {
          mode: input.mode,
          ...(input.mentionedSourceIds && input.mentionedSourceIds.length > 0
            ? { mentionedSourceIds: input.mentionedSourceIds }
            : {}),
          ...(input.sourceIds ? { sourceIds: input.sourceIds } : {}),
          timezone: resolveClientTimezone(),
          idempotencyKey: durableRunKey,
        };
        if (input.command) {
          requestBody.command = input.command;
        }
        const selectedSkillIds = input.skillIds ?? [];
        const effectiveByokSelections = input.byokSelections ?? selectedByokModels;

        requestBody.tools = buildChatToolsRequest({
          imageExecution:
            effectiveByokSelections.image?.mode === "byok"
              ? buildByokModelExecution({
                  selection: effectiveByokSelections.image,
                })
              : null,
          invokedSkillIds: input.tools?.invokedSkillIds,
          skillIds: selectedSkillIds,
          searchEnabled: input.searchEnabled ?? searchEnabled,
          tools: input.tools,
          forceImageGenerate:
            input.command?.kind === "tool" &&
            input.command.name === `/${AGENT_TOOL_NAMES.generateImage}`,
        });
        const selectedLlmProfileAlias =
          streamWithSelectedLlm && catalogKindEnabled.llm
            ? selectedModels.llm?.profileAlias ?? selectedModels.llm?.id
            : undefined;
        const requestThinking =
          input.thinking ??
          buildRequestThinking({
            capabilities: selectedModels.llm?.capabilities,
            settings: thinkingSettings,
          });
        const byokLlmRequest = buildByokModelExecution({
          selection: effectiveByokSelections.llm,
          thinking: requestThinking,
        });
        if (effectiveByokSelections.llm?.mode === "byok") {
          requestBody.llm = byokLlmRequest;
        } else if (
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
        if (
          !input.attachOnly &&
          (input.mode === "send" || input.mode === "edit")
        ) {
          requestBody.content = input.content ?? "";
          if (
            input.mode === "edit" ||
            (input.images && input.images.length > 0)
          ) {
            requestBody.images = input.images;
          }
        }
        const modelSettings: Record<string, string> = {};
        const byokVisionRequest = buildByokModelExecution({
          selection: effectiveByokSelections.vision,
        });
        if (effectiveByokSelections.vision?.mode === "byok") {
          requestBody.vision = byokVisionRequest;
        } else if (catalogKindEnabled.vision && selectedModels.vision) {
          modelSettings.visionProfileAlias =
            selectedModels.vision.profileAlias ?? selectedModels.vision.id;
        }
        if (effectiveByokSelections.image?.mode === "byok") {
          requestBody.image = buildByokModelExecution({
            selection: effectiveByokSelections.image,
          });
        } else if (catalogKindEnabled.image && selectedModels.image?.profileAlias) {
          modelSettings.imageProfileAlias = selectedModels.image.profileAlias;
        }
        if (Object.keys(modelSettings).length > 0) {
          requestBody.modelSettings = modelSettings;
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
          await throwStreamRequestError(response);
        }

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error("No response body");
        }

        const decoder = new TextDecoder();
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
              appendStreamRenderText(nextDelta);
              latestAssistantMessageContent = assistantText;
              flushSync(() => {
                setMessages((previous) =>
                  previous.map((message) =>
                    message.id === streamingAssistantMessageId
                      ? {
                          ...message,
                          content: assistantText,
                          metadata: {
                            ...message.metadata,
                            renderBlocks: snapshotStreamRenderBlocks(),
                            threadRun: {
                              ...(toObjectRecord(message.metadata.threadRun) ??
                                {}),
                              idempotencyKey: durableRunKey,
                              status: "running",
                              mode: input.mode,
                            },
                          },
                        }
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
            const chunk = chars.slice(index, index + maxChunkSize).join("");
            deltaQueue.push(chunk);
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
                        renderBlocks: snapshotStreamRenderBlocks(),
                        threadRun: {
                          ...(toObjectRecord(message.metadata.threadRun) ?? {}),
                          idempotencyKey: durableRunKey,
                          status: "running",
                          mode: input.mode,
                        },
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
                        renderBlocks: snapshotStreamRenderBlocks(),
                        threadRun: {
                          ...(toObjectRecord(message.metadata.threadRun) ?? {}),
                          idempotencyKey: durableRunKey,
                          status: "running",
                          mode: input.mode,
                        },
                      },
                    }
                  : message,
              ),
            );
          });
        };

        const syncStreamingCitations = (citationInput: {
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
                          citations: citationInput.citations,
                          availableCitations:
                            citationInput.availableCitations ??
                            citationInput.citations,
                        },
                        threadRun: {
                          ...(toObjectRecord(message.metadata.threadRun) ?? {}),
                          idempotencyKey: durableRunKey,
                          status: "running",
                          mode: input.mode,
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
              const serverMentionedSourceIds = Array.isArray(
                data.mentionedSourceIds,
              )
                ? data.mentionedSourceIds.filter(
                    (sourceId): sourceId is string =>
                      typeof sourceId === "string",
                  )
                : null;
              const serverEffectiveMentionedSourceIds = Array.isArray(
                data.effectiveMentionedSourceIds,
              )
                ? data.effectiveMentionedSourceIds.filter(
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
              const serverContentJson = toObjectRecord(data.contentJson);
              const serverCommand = normalizeThreadCommandRequest(data.command);
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
                          contentJson: serverContentJson
                            ? serverContentJson
                            : message.contentJson,
                          metadata: {
                            ...message.metadata,
                            ...(serverCommand ? { command: serverCommand } : {}),
                            ...(serverSourceIds
                              ? { sourceIds: serverSourceIds }
                              : {}),
                            ...(serverMentionedSourceIds
                              ? { mentionedSourceIds: serverMentionedSourceIds }
                              : {}),
                            ...(serverEffectiveSourceIds
                              ? { effectiveSourceIds: serverEffectiveSourceIds }
                              : {}),
                            ...(serverEffectiveMentionedSourceIds
                              ? {
                                  effectiveMentionedSourceIds:
                                    serverEffectiveMentionedSourceIds,
                                }
                              : {}),
                          },
                        }
                      : message.id === streamingAssistantMessageId
                        ? {
                            ...message,
                            metadata: {
                              ...message.metadata,
                              userMessageId: serverUserMessageId,
                              sourceUserMessageId: serverUserMessageId,
                              threadRun: {
                                ...(toObjectRecord(
                                  message.metadata.threadRun,
                                ) ?? {}),
                                idempotencyKey: durableRunKey,
                                status: "running",
                                mode: input.mode,
                              },
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
                              renderBlocks: snapshotStreamRenderBlocks(),
                            },
                          }
                        : message,
                    ),
                  );
                });
              }
              enqueueDelta(data.delta);
              startDeltaDrain();
            } else if (
              data.type === "text-replace" &&
              typeof data.text === "string"
            ) {
              deltaQueue.length = 0;
              assistantText = data.text;
              latestAssistantMessageContent = assistantText;
              hasRenderedDelta = assistantText.length > 0;
              streamRenderBlocks.length = 0;
              flushSync(() => {
                setMessages((previous) =>
                  previous.map((message) =>
                    message.id === streamingAssistantMessageId
                      ? {
                          ...message,
                          content: assistantText,
                          metadata: {
                            ...message.metadata,
                            [STREAM_TEXT_PAUSED_KEY]: false,
                            renderBlocks: [],
                          },
                        }
                      : message,
                  ),
                );
              });
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
              if (
                data.type === "tool-call-start" &&
                isGeneratedImageArtifactToolName(nextToolCall.tool)
              ) {
                drainQueuedDeltasNow();
                appendStreamGeneratedImageBlock(nextToolCall.id);
              }
              syncStreamingToolCalls();
              if (
                isCompletedWorkfileWriteToolCall(nextToolCall, data) &&
                !refreshedWorkfileToolIds.has(nextToolCall.id)
              ) {
                refreshedWorkfileToolIds.add(nextToolCall.id);
                setWorkfilesRefreshKey((value) => value + 1);
              }
              if (
                isCompletedImageArtifactToolCall(nextToolCall, data) &&
                !refreshedArtifactToolIds.has(nextToolCall.id)
              ) {
                refreshedArtifactToolIds.add(nextToolCall.id);
                setArtifactsRefreshKey((value) => value + 1);
              }
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
                          threadRun: {
                            ...(toObjectRecord(message.metadata.threadRun) ??
                              {}),
                            idempotencyKey: durableRunKey,
                            status: "running",
                            mode: input.mode,
                          },
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
              const errorMessage = data.error ?? "Model error";
              suppressErrorToast = data.code === "CLIENT_CANCELLED";
              markStreamingAssistantAsError({
                code: data.code ?? null,
                error: errorMessage,
                messageId:
                  typeof data.messageId === "string" ? data.messageId : null,
                parentMessageId:
                  data.parentMessageId === undefined
                    ? null
                    : data.parentMessageId,
                parentMessageIdProvided: data.parentMessageId !== undefined,
                serverPersisted: typeof data.messageId === "string",
                userMessageId: data.userMessageId ?? persistedUserMessageId,
              });
              streamError = new Error(errorMessage);
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
                            renderBlocks: snapshotStreamRenderBlocks(),
                            threadRun: {
                              ...(toObjectRecord(message.metadata.threadRun) ??
                                {}),
                              idempotencyKey: durableRunKey,
                              status: "completed",
                              mode: input.mode,
                            },
                          },
                        }
                      : message,
                  ),
                );
              });
            } else if (data.type === "finish") {
              receivedFinishEvent = true;
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
                      ? (() => {
                          const existingRun = toObjectRecord(
                            message.metadata.threadRun,
                          );
                          const existingStatus =
                            toNullableString(existingRun?.status);
                          const nextStatus =
                            existingStatus === "failed" ||
                            existingStatus === "cancelled"
                              ? existingStatus
                              : "completed";
                          return {
                            ...message,
                            metadata: {
                              ...message.metadata,
                              [STREAM_TEXT_PAUSED_KEY]: false,
                              renderBlocks: snapshotStreamRenderBlocks(),
                              threadRun: {
                                ...(existingRun ?? {}),
                                idempotencyKey: durableRunKey,
                                status: nextStatus,
                                mode: input.mode,
                              },
                            },
                          };
                        })()
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
        if (!receivedFinishEvent) {
          detachedWithoutFinish = true;
          return;
        }

        const usedSourceIds = new Set(input.sourceIds ?? []);
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
          expandSelectedSources(librarySources, input.sourceIds ?? []).map(
            (source) => source.id,
          );
        currentEffectiveSourceIds.forEach((sourceId) => {
          usedSourceIds.add(sourceId);
        });
        updateChatSourceCount(threadId, usedSourceIds.size);

        setWorkfilesRefreshKey((value) => value + 1);
        if (refreshedArtifactToolIds.size > 0) {
          setArtifactsRefreshKey((value) => value + 1);
        }
        if (shouldPollThreadTitle && pendingTitleJobId) {
          void pollThreadTitleJob(pendingTitleJobId);
        }
        setActiveThreadRun((current) =>
          current?.idempotencyKey === durableRunKey ? null : current,
        );
        attachedRunKeyRef.current =
          attachedRunKeyRef.current === durableRunKey
            ? null
            : attachedRunKeyRef.current;
      } catch (error) {
        const errorMessage = getDisplayErrorMessage(error);
        const hadServerPersistedAssistantMessage =
          hasServerPersistedAssistantMessage;
        const existingPersistedAssistantMessageId = persistedAssistantMessageId;
        const hasServerUserMessage =
          persistedUserMessageId !== null &&
          !persistedUserMessageId.startsWith("temp-user-");

        if (
          !existingPersistedAssistantMessageId &&
          (hasServerUserMessage || input.attachOnly)
        ) {
          markStreamingAssistantAsError({
            error: errorMessage,
            userMessageId: persistedUserMessageId,
          });
        }

        if (!existingPersistedAssistantMessageId) {
          if (hasServerUserMessage) {
            window.setTimeout(() => {
              void loadThreadMessages();
            }, 750);
          } else {
            setMessages((previous) => {
              const withoutFailedTemporaryMessages = previous.filter(
                (message) =>
                  message.id !== streamingAssistantMessageId &&
                  (!createdUserMessageId ||
                    message.id !== createdUserMessageId),
              );
              return withoutFailedTemporaryMessages;
            });
            if (
              !input.attachOnly &&
              input.mode === "send" &&
              typeof input.content === "string"
            ) {
              setComposerInitialInput(input.content);
              setComposerResetKey((value) => value + 1);
            }
          }
        } else if (hadServerPersistedAssistantMessage) {
          window.setTimeout(() => {
            void loadThreadMessages();
          }, 0);
        }

        if (!suppressErrorToast) {
          toast.error(errorMessage);
        }
      } finally {
        if (!detachedWithoutFinish) {
          setIsStreaming(false);
          setIsStopping(false);
          setActiveThreadRun((current) =>
            current?.idempotencyKey === durableRunKey ? null : current,
          );
          dispatchDashboardBillingSummaryRefresh({
            reason: "chat-turn-terminal",
          });
        } else {
          setIsStopping(false);
        }
      }
    },
    [
      catalogKindEnabled.image,
      catalogKindEnabled.llm,
      catalogKindEnabled.vision,
      clearEditingState,
      loadThreadMessages,
      librarySources,
      messages,
      selectedByokModels,
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

  const handleStopStreaming = useCallback(() => {
    const run = activeThreadRunRef.current;
    if (!workspaceId || !run || isStopping) {
      return;
    }

    setIsStopping(true);
    setActiveThreadRun({
      ...run,
      status: "cancel_requested",
    });
    void fetch(
      `${apiBaseUrl}/v1/workspaces/${workspaceId}/threads/${threadId}/stream`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          idempotencyKey: `${run.idempotencyKey}${SOURCEWEFT_WEB_RUN_STOP_SUFFIX}`,
          stream: false,
        }),
      },
    )
      .then(async (response) => {
        if (!response.ok) {
          await throwStreamRequestError(response);
        }
      })
      .catch((error) => {
        toast.error(getDisplayErrorMessage(error));
        setIsStopping(false);
        setActiveThreadRun((current) =>
          current?.idempotencyKey === run.idempotencyKey ? run : current,
        );
      });
  }, [isStopping, threadId, workspaceId]);

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
          images,
          mentionedSourceIds,
          sourceIds,
          skillIds,
          tools,
          command,
          thinking,
          thinkingSettings: pendingThinkingSettings,
          searchEnabled: pendingSearchEnabled,
          modelState: pendingModelState,
        } = JSON.parse(raw) as {
          content: string;
          images?: ChatSendInput["images"];
          mentionedSourceIds?: string[];
          sourceIds: string[];
          skillIds?: string[];
          tools?: ChatSendInput["tools"];
          command?: ChatSendInput["command"];
          thinking?: RequestThinkingConfig;
          thinkingSettings?: PromptThinkingSettings;
          searchEnabled?: boolean;
          modelState?: {
            availableModels?: Record<ModelType, ModelItem[]>;
            catalogKindEnabled?: Record<ModelType, boolean>;
            selectedModels?: SelectedModels;
            byokSelection?: ByokModelSelection | null;
            byokSelections?: Partial<Record<ModelType, ByokModelSelection | null>>;
          };
        };
        const pendingSourceIds = Array.isArray(sourceIds)
          ? sourceIds.filter(
              (sourceId): sourceId is string => typeof sourceId === "string",
            )
          : [];
        const pendingMentionedSourceIds = Array.isArray(mentionedSourceIds)
          ? mentionedSourceIds.filter(
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
          setBaseSelectedModels(pendingModelState.selectedModels);
          setModelSelectionSources(DEFAULT_MODEL_SELECTION_SOURCES);
        }
        if (pendingModelState?.byokSelections) {
          setSelectedByokModels(pendingModelState.byokSelections);
        } else if (pendingModelState?.byokSelection) {
          setSelectedByokModels({ llm: pendingModelState.byokSelection });
        }
        void streamThreadActionRef.current({
          mode: "send",
          content,
          images: Array.isArray(images) ? images : undefined,
          mentionedSourceIds: pendingMentionedSourceIds,
          sourceIds: pendingSourceIds,
          skillIds: pendingSkillIds,
          tools,
          command,
          thinking,
          byokSelections:
            pendingModelState?.byokSelections ??
            (pendingModelState?.byokSelection
              ? { llm: pendingModelState.byokSelection }
              : undefined),
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
    async (input: ChatSendInput) => {
      const text = input.content.trim();
      const images = input.images ?? [];
      if ((!text && images.length === 0) || isStreaming) {
        return;
      }

      const contextSourceIds = resolveContextSourceIds({
        messages,
        activeSourceIds,
      });
      const mentionedSourceIds = mergeSourceIds(input.mentionedSourceIds);
      const sendSourceIds = mergeSourceIds(contextSourceIds);
      const selectedSkillIds = input.skillIds ?? effectiveActiveSkillIds;

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
          turnId: editingAssistantGroup?.turnId,
        };

        const editSourceIds = resolveEditSourceIds({
          activeSourceIds,
          editingMessageId,
          groups: messageGroups,
        });
        const mergedEditSourceIds = mergeSourceIds(editSourceIds);

        await streamThreadAction({
          mode: "edit",
          content: text,
          images,
          mentionedSourceIds,
          sourceIds: mergedEditSourceIds,
          skillIds: selectedSkillIds,
          tools: input.tools,
          command: input.command,
          searchEnabled,
          userMessageId: editingMessageId,
          assistantMessageId: editingAssistantMessageId,
        });
        return;
      }

      await streamThreadAction({
        mode: "send",
        content: text,
        images,
        mentionedSourceIds,
        sourceIds: sendSourceIds,
        skillIds: selectedSkillIds,
        tools: input.tools,
        command: input.command,
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
      effectiveActiveSkillIds,
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
        turnId: assistantGroup?.turnId,
      };

      const refreshSourceIds = resolveRefreshSourceIds({
        activeSourceIds,
        assistantMessageId: input.assistantMessageId,
        groups: messageGroups,
      });

      await streamThreadAction({
        mode: "refresh",
        sourceIds: refreshSourceIds,
        skillIds: effectiveActiveSkillIds,
        searchEnabled,
        assistantMessageId: input.assistantMessageId,
      });
    },
    [
      activeSourceIds,
      effectiveActiveSkillIds,
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
      setComposerInitialCommand(null);
      setComposerResetKey((value) => value + 1);
    },
    [cancelEditing, editingMessageId],
  );

  const handleWorkspaceShortcut = useCallback(
    (targetWorkspaceId: string) => {
      if (targetWorkspaceId === workspaceId) {
        return;
      }

      startNewChat();
      void switchWorkspace(targetWorkspaceId);
      router.push("/dashboard/chat");
    },
    [router, startNewChat, switchWorkspace, workspaceId],
  );

  const shortcutDefinitions = useMemo<DashboardShortcutDefinition[]>(
    () =>
      workspaces
        .slice(0, DASHBOARD_WORKSPACE_SHORTCUT_LIMIT)
        .map((workspace, index) => ({
          group: "Workspace",
          id: `workspace-${workspace.id}`,
          keys: getDashboardWorkspaceShortcutKeys(index, shortcutPlatform),
          onRun: () => handleWorkspaceShortcut(workspace.id),
          title: `Switch to ${workspace.name}`,
        })),
    [handleWorkspaceShortcut, shortcutPlatform, workspaces],
  );

  useDashboardShortcuts(shortcutDefinitions);

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
                byokCredentials={byokCredentials}
                byokModels={byokModels}
                byokProviders={byokProviders}
                byokSelections={selectedByokModels}
                onAddByokModel={(input) => setByokModelConfig(input)}
                onByokSelect={({ model, selection, type }) => {
                  setModelSelectionSources((current) => ({
                    ...current,
                    [type]: "user",
                  }));
                  setSelectedModels((current) => ({
                    ...current,
                    [type]: model,
                  }));
                  setSelectedByokModels((current) => ({
                    ...current,
                    [type]: selection,
                  }));
                  if (type === "llm") {
                    setThinkingSettings((current) =>
                      normalizeThinkingSettingsForModel({
                        capabilities: model.capabilities,
                        hasSavedPreference: hasSavedThinkingPreference,
                        settings: current,
                      }),
                    );
                    setStreamWithSelectedLlm(true);
                  }
                }}
                onModelSelect={handleModelSelect}
                selectedModels={selectedModels}
                setSelectedModels={setSelectedModels}
              />
            </div>

            <div className="ml-auto flex items-center gap-2">
              <Button
                onClick={() => setShortcutsOpen(true)}
                size="icon-sm"
                title="Keyboard shortcuts"
                type="button"
                variant="outline"
              >
                <Keyboard className="h-4 w-4" />
                <span className="sr-only">Keyboard shortcuts</span>
              </Button>
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
          composerInitialCommand={composerInitialCommand}
          composerInitialInput={composerInitialInput}
          composerResetKey={composerResetKey}
          editingMessageId={editingMessageId}
          highlightedMessageId={highlightedMessageId}
          isEditing={Boolean(editingMessageId && editingGroupId)}
          isStreaming={isStreaming}
          isStopping={isStopping}
          messageGroups={messageGroups}
          mode="thread"
          onActiveVersionChange={handleActiveVersionChange}
          onArtifactPreview={handleArtifactPreview}
          onCancelEditing={cancelEditing}
          onCitationClick={handleCitationClick}
          onSourcePreview={handleSourcePreview}
          onWorkfileClick={handleWorkfilePreview}
          onRemoveSource={(id) =>
            persistActiveSourceIds(activeSourceIds.filter((x) => x !== id))
          }
          onRefreshLatest={handleRefreshLatest}
          onRestartFromMessage={handleRestartFromMessage}
          onSendMessage={handleSendMessage}
          onSkillSelectionChange={setActiveSkillIds}
          onStopStreaming={handleStopStreaming}
          searchEnabled={searchEnabled}
          onSearchEnabledChange={setSearchEnabled}
          sourceMentionLoader={loadSourceMentions}
          selectedSources={selectedSources}
          selectedSkillIds={activeSkillIds}
          sourcesVisible={sourcesVisible}
          thinkingCapabilities={selectedModels.llm?.capabilities}
          imageCapabilities={
            selectedModels.image?.capabilities?.imageGeneration
          }
          imageModelAvailable={Boolean(selectedModels.image)}
          imageModelAlias={selectedModels.image?.modelAlias ?? null}
          disabledToolNames={disabledToolNames}
          onDisabledToolNamesChange={setDisabledToolNames}
          thinkingSettings={thinkingSettings}
          onThinkingSettingsChange={handleThinkingSettingsChange}
          threadTitle={threadTitle}
          workspaceId={workspaceId}
        />
      </div>

      {sourcesVisible && (!previewArtifact || !isDesktopPanel) ? (
        <SourcesHub
          activeCitationIndex={activeCitationIndex}
          artifactsRefreshKey={artifactsRefreshKey}
          citations={displayedCitations}
          currentCitationMessageId={activeAssistantVersion?.id ?? null}
          disabledToolNames={disabledToolNames}
          installedSkills={availableSkills}
          mode="thread"
          onArtifactOpen={setPreviewArtifact}
          onCitationLocate={scrollToMessage}
          onCitationOpen={handleSourceHubCitationOpen}
          initialSources={initialSourcesForWorkspace}
          initialSourcesLoaded={hasCachedWorkspaceSources(workspaceId)}
          onSkillSelectionChange={setActiveSkillIds}
          onSelectionChange={persistActiveSourceIds}
          onSkillsCatalogChange={loadAvailableSkills}
          onSourceLoad={handleLibrarySourcesLoad}
          selectedIds={activeSourceIds}
          selectedSkillIds={activeSkillIds}
          threadCitations={threadCitations}
          threadId={threadId}
          workfilesRefreshKey={workfilesRefreshKey}
          workspaceId={workspaceId}
          workspaceName={workspaceName}
        />
      ) : null}

      {sourcesVisible && previewArtifact && isDesktopPanel ? (
        <ArtifactPreviewPanel
          artifact={previewArtifact}
          className="w-[min(640px,45vw)] min-w-[480px] max-w-[720px] shrink-0 animate-in slide-in-from-right-4 duration-200"
          onClose={() => setPreviewArtifact(null)}
          workspaceId={workspaceId}
        />
      ) : null}

      <ByokModelConfigDialog
        defaults={byokModelConfig}
        credentials={byokCredentials}
        onConfigured={({ model, selection, type }) => {
          if (!model || !selection) {
            return;
          }
          setModelSelectionSources((current) => ({
            ...current,
            [type]: "user",
          }));
          setSelectedModels((current) => ({
            ...current,
            [type]: model,
          }));
          setSelectedByokModels((current) => ({
            ...current,
            [type]: selection,
          }));
          if (type === "llm") {
            setThinkingSettings((current) =>
              normalizeThinkingSettingsForModel({
                capabilities: model.capabilities,
                hasSavedPreference: hasSavedThinkingPreference,
                settings: current,
              }),
            );
            setStreamWithSelectedLlm(true);
          }
        }}
        onOpenChange={(open) => {
          if (!open) {
            setByokModelConfig(null);
          }
        }}
        onStateChange={({ credentials, models, providers }) => {
          setByokCredentials(credentials);
          setByokModels(models);
          setByokProviders(providers);
        }}
        open={Boolean(byokModelConfig)}
        providers={byokProviders}
        workspaceId={workspaceId}
      />

      <DashboardShortcutsDialog
        definitions={shortcutDefinitions}
        onOpenChange={setShortcutsOpen}
        open={shortcutsOpen}
      />

      <Sheet
        open={Boolean(sourcesVisible && previewArtifact && !isDesktopPanel)}
        onOpenChange={(open) => {
          if (!open) {
            setPreviewArtifact(null);
          }
        }}
      >
        <SheetContent
          className="h-[90svh] max-h-[90svh] gap-0 overflow-hidden p-0 [&>button]:hidden"
          side="bottom"
        >
          <SheetTitle className="sr-only">
            {previewArtifact ? "Artifact preview" : "Artifact"}
          </SheetTitle>
          {previewArtifact ? (
            <ArtifactPreviewPanel
              artifact={previewArtifact}
              className="border-l-0"
              onClose={() => setPreviewArtifact(null)}
              workspaceId={workspaceId}
            />
          ) : null}
        </SheetContent>
      </Sheet>

      <SourcePreviewPanel
        citation={previewCitation}
        onOpenChange={(open) => {
          if (!open) {
            setPreviewCitation(null);
            setPreviewSource(null);
          }
        }}
        open={Boolean(previewCitation || previewSource)}
        source={previewSource}
        workspaceId={workspaceId}
      />

      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            setPreviewWorkfile(null);
          }
        }}
        open={Boolean(previewWorkfile)}
      >
        <DialogContent
          className="grid max-h-[min(720px,calc(100svh-2rem))] w-[760px] max-w-[calc(100%-2rem)] grid-rows-[auto_minmax(0,1fr)] p-0"
          constrainWidth={false}
        >
          <DialogHeader className="border-b px-5 py-4 text-left">
            <DialogTitle>
              {previewWorkfile ? basename(previewWorkfile.path) : "Workfile"}
            </DialogTitle>
            <DialogDescription>
              {previewWorkfile
                ? `${previewWorkfile.path} · ${formatBytes(previewWorkfile.sizeBytes)} · ${workfilePurposeLabel(previewWorkfile.purpose)}`
                : "Assistant-created working material from this thread."}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto px-5 py-5">
            {previewWorkfile ? (
              <MessageResponse className="text-sm leading-7 text-foreground [&_pre]:my-3 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:bg-muted/30 [&_pre]:p-3">
                {previewWorkfile.contentText}
              </MessageResponse>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
