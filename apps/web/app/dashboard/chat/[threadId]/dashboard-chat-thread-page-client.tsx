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
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
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
import { SidebarTrigger } from "@sourceweft/ui-web/components/ui/sidebar";
import { useDashboardChatState } from "../../_components/dashboard-chat-state";
import {
  DASHBOARD_WORKSPACE_SHORTCUT_LIMIT,
  DashboardShortcutsDialog,
  getDashboardWorkspaceShortcutKeys,
  useDashboardShortcuts,
  useDashboardShortcutsOpenListener,
  useDashboardShortcutPlatform,
  type DashboardShortcutDefinition,
} from "../../_components/dashboard-shortcuts";
import {
  emptyModelCatalog,
  mapCatalogKindsToModelItems,
  resolveSelectedModels,
  resolveSelectedModelsWithByok,
  type ModelAliasSettings,
  type ModelItem,
  type SelectedModels,
  type ModelType,
} from "../_components/model-catalog-utils";
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
import type { ByokModelConfigDefaults } from "../_components/byok-model-config-dialog";
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
import type {
  ArtifactListItem,
  ThreadCitationRecord,
} from "../_components/sources-hub";
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
} from "@sourceweft/sdk";
import { SourcesHubPanelSkeleton } from "../../../_components/route-loading-skeleton";
import {
  useChatStreamRunnerControl,
  type ActiveThreadRun,
} from "./chat-stream-runner-control";
import {
  buildStreamingThreadRequestBody,
  type RequestThinkingConfig,
} from "./streaming-request-body";
import {
  createStreamingEventHandlerContext,
  handleStreamingAssistantMessage,
  handleStreamingCitations,
  handleStreamingError,
  handleStreamingFinish,
  handleStreamingReasoning,
  handleStreamingStart,
  handleStreamingTextDelta,
  handleStreamingTextInterrupted,
  handleStreamingTextReplace,
  handleStreamingThinkingStep,
  handleStreamingThreadTitlePending,
  handleStreamingThreadTitleUpdate,
  handleStreamingToolCallEvent,
} from "./streaming-event-handlers";
import {
  useStreamingAssistantTransientState,
  type ChatMessageItem,
} from "./streaming-assistant-state";
import { createStreamingEventParser } from "./streaming-event-parser";
import { createStreamingRenderBuffer } from "./streaming-render-buffer";

const apiBaseUrl =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

const SourcesHub = dynamic(
  () => import("../_components/sources-hub").then((mod) => mod.SourcesHub),
  {
    loading: () => (
      <SourcesHubSkeleton className="hidden w-[min(420px,34vw)] shrink-0 md:block" />
    ),
    ssr: false,
  },
);

const ArtifactPreviewPanel = dynamic(
  () =>
    import("../_components/sources-hub").then(
      (mod) => mod.ArtifactPreviewPanel,
    ),
  {
    loading: () => (
      <SourcesHubSkeleton className="hidden w-[min(640px,45vw)] shrink-0 md:block" />
    ),
    ssr: false,
  },
);

const SourcePreviewPanel = dynamic(
  () =>
    import("../_components/source-preview-panel").then(
      (mod) => mod.SourcePreviewPanel,
    ),
  { ssr: false },
);

const ByokModelConfigDialog = dynamic(
  () =>
    import("../_components/byok-model-config-dialog").then(
      (mod) => mod.ByokModelConfigDialog,
    ),
  { ssr: false },
);

const HeaderModelSelector = dynamic(
  () =>
    import("../_components/header-model-selector").then(
      (mod) => mod.HeaderModelSelector,
    ),
  {
    loading: () => (
      <div className="h-10 w-36 shrink-0 animate-pulse rounded-md bg-muted" />
    ),
    ssr: false,
  },
);

function SourcesHubSkeleton({ className }: { className?: string }) {
  return <SourcesHubPanelSkeleton className={className} />;
}

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

function mapThreadMessagesToChatMessages(messages: ThreadMessageItem[]) {
  return messages
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
        new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
    );
}

const STREAM_TEXT_PAUSED_KEY = "isTextPaused";
const STREAM_TEXT_INTERRUPTED_KEY = "isTextInterrupted";
const STREAM_RENDER_KEY = "renderKey";
const TITLE_POLL_INTERVAL_MS = 1000;
const TITLE_POLL_TIMEOUT_MS = 60000;
const THREAD_MESSAGES_LOAD_RETRY_DELAYS_MS = [300, 1000, 2500] as const;
const THREAD_MESSAGES_INITIAL_PAGE_SIZE = 80;
const STREAM_DELTA_MAX_BATCH_CHARS = 800;

type PendingLatestVersionSelection = {
  userGroupId?: string;
  assistantGroupId?: string;
  turnId?: string;
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

export function DashboardChatThreadPageClient({
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
  const {
    mergeStreamingAssistantIntoMessages,
    setStreamingAssistantSnapshot,
  } = useStreamingAssistantTransientState();
  const [olderMessagesCursor, setOlderMessagesCursor] = useState<string | null>(
    null,
  );
  const [isLoadingOlderMessages, setIsLoadingOlderMessages] = useState(false);
  const {
    activeThreadRun,
    attachedRunKeyRef,
    clearAttachedRunKeyIfCurrent,
    clearRunIfCurrent,
    isStopping,
    isStreaming,
    markRunStarted,
    markRunTerminal,
    setActiveThreadRun,
    stopStreaming: handleStopStreaming,
  } = useChatStreamRunnerControl({
    getDisplayErrorMessage,
    threadId,
    throwStreamRequestError,
    workspaceId,
  });
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
  const isPersistentLayout = useMediaQuery("(min-width: 768px)");
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
  useDashboardShortcutsOpenListener(() => setShortcutsOpen(true));
  const [hubDrawerOpen, setHubDrawerOpen] = useState(false);
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
  const handleLibrarySourcesMerge = useCallback((sources: SourceItem[]) => {
    setLibrarySources((current) => {
      const mergedById = new Map(current.map((source) => [source.id, source]));
      for (const source of sources) {
        mergedById.set(source.id, source);
      }
      return Array.from(mergedById.values());
    });
  }, []);

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
    () => buildVersionedMessageGroups(mergeStreamingAssistantIntoMessages(messages)),
    [mergeStreamingAssistantIntoMessages, messages],
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
      setStreamingAssistantSnapshot(null);
      setOlderMessagesCursor(null);
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
          contentClient.listThreadMessages(workspaceId, threadId, {
            include: "metadata,contentJson,citations",
            limit: THREAD_MESSAGES_INITIAL_PAGE_SIZE,
          }),
          contentClient.getActiveThreadRun(workspaceId, threadId),
        ]);
        let serverMessages = mapThreadMessagesToChatMessages(
          messagesResult.items,
        );
        const activeRun = activeRunResult.threadRun;

        if (threadMessagesLoadGenerationRef.current !== loadGeneration) {
          return;
        }

        loadedThreadMessagesKeyRef.current = threadMessagesKey;
        setOlderMessagesCursor(messagesResult.nextCursor ?? null);
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
        setStreamingAssistantSnapshot(null);
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
            setStreamingAssistantSnapshot(null);
            setOlderMessagesCursor(null);
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

  const loadOlderThreadMessages = useCallback(async () => {
    if (!workspaceId || !olderMessagesCursor || isLoadingOlderMessages) {
      return;
    }

    setIsLoadingOlderMessages(true);
    try {
      const result = await contentClient.listThreadMessages(
        workspaceId,
        threadId,
        {
          cursor: olderMessagesCursor,
          include: "metadata,contentJson,citations",
          limit: THREAD_MESSAGES_INITIAL_PAGE_SIZE,
        },
      );
      const olderMessages = mapThreadMessagesToChatMessages(result.items);
      setMessages((current) => {
        const mergedById = new Map(
          [...olderMessages, ...current].map((message) => [
            message.id,
            message,
          ]),
        );
        return Array.from(mergedById.values()).sort(
          (left, right) =>
            new Date(left.createdAt).getTime() -
            new Date(right.createdAt).getTime(),
        );
      });
      setOlderMessagesCursor(result.nextCursor ?? null);
    } catch {
      toast.error("Failed to load earlier messages.");
    } finally {
      setIsLoadingOlderMessages(false);
    }
  }, [isLoadingOlderMessages, olderMessagesCursor, threadId, workspaceId]);

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

      const durableRunKey = input.durableRunKey ?? createDurableRunKey();
      markRunStarted({
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
      const streamRenderBuffer = createStreamingRenderBuffer({
        maxDeltaBatchChars: STREAM_DELTA_MAX_BATCH_CHARS,
      });
      const refreshedWorkfileToolIds = new Set<string>();
      const refreshedArtifactToolIds = new Set<string>();
      let streamingAssistantMessageId = input.attachOnly
        ? (input.assistantMessageId ??
          latestAssistantMessage?.id ??
          tempAssistantId)
        : tempAssistantId;
      const streamingAssistantMessageIds = new Set<string>([
        streamingAssistantMessageId,
      ]);
      let preparedEffectiveSourceIds: string[] | null = null;
      let assistantText = "";
      let latestAssistantMessageContent = "";
      let streamError: Error | null = null;
      let hasRenderedDelta = false;
      let streamEnded = false;
      let receivedFinishEvent = false;
      let detachedWithoutFinish = false;
      let drainPromise: Promise<void> | null = null;
      let suppressErrorToast = false;
      let streamingAssistantMessage =
        messageSnapshot.find(
          (message) => message.id === streamingAssistantMessageId,
        ) ??
        temporaryMessages.find(
          (message) => message.id === streamingAssistantMessageId,
        ) ??
        latestAssistantMessage ??
        null;

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
        streamRenderBuffer.replaceRenderBlocks(
          resolveRenderBlocksFromMetadata(latestAssistantMessage.metadata),
        );
      }

      if (streamingAssistantMessage) {
        setStreamingAssistantSnapshot({
          message: streamingAssistantMessage,
          messageId: streamingAssistantMessage.id,
          messageIds: Array.from(streamingAssistantMessageIds),
          renderVersion: 0,
        });
      }

      const waitForAnimationFrame = () =>
        new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => resolve());
        });

      const updateStreamingAssistantMessage = (
        updater: (message: ChatMessageItem) => ChatMessageItem,
      ) => {
        if (!streamingAssistantMessage) {
          return;
        }
        streamingAssistantMessage = updater(streamingAssistantMessage);
        setStreamingAssistantSnapshot((current) => ({
          message: streamingAssistantMessage as ChatMessageItem,
          messageId: streamingAssistantMessageId,
          messageIds: Array.from(streamingAssistantMessageIds),
          renderVersion: (current?.renderVersion ?? 0) + 1,
        }));
      };

      const syncLatestAssistantMessageContent = () => {
        latestAssistantMessageContent =
          streamingAssistantMessage?.content ?? assistantText;
      };

      const commitStreamingAssistantMessage = () => {
        const committedMessage = streamingAssistantMessage;
        if (!committedMessage) {
          setStreamingAssistantSnapshot(null);
          return;
        }
        streamingAssistantMessageIds.add(streamingAssistantMessageId);
        streamingAssistantMessageIds.add(committedMessage.id);
        setMessages((previous) => {
          let found = false;
          const next = previous.map((message) => {
            if (!streamingAssistantMessageIds.has(message.id)) {
              return message;
            }
            found = true;
            return committedMessage;
          });
          return found ? next : [...next, committedMessage];
        });
        setStreamingAssistantSnapshot(null);
      };

      const drainQueuedDeltasNow = () => {
        if (!streamRenderBuffer.hasQueuedDeltas()) {
          syncLatestAssistantMessageContent();
          return;
        }

        const nextDelta = streamRenderBuffer.drainQueuedDeltas();
        assistantText += nextDelta;
        streamRenderBuffer.appendText(nextDelta);
        latestAssistantMessageContent = assistantText;
        updateStreamingAssistantMessage((message) => ({
          ...message,
          content: assistantText,
          metadata: {
            ...message.metadata,
            renderBlocks: streamRenderBuffer.snapshotRenderBlocks(),
            threadRun: {
              ...(toObjectRecord(message.metadata.threadRun) ?? {}),
              idempotencyKey: durableRunKey,
              status: "running",
              mode: input.mode,
            },
          },
        }));
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
        streamingAssistantMessageIds.add(previousAssistantMessageId);
        streamingAssistantMessageIds.add(messageId);
        const userMessageId =
          errorInput.userMessageId ?? persistedUserMessageId;
        const isClientCancelled = errorInput.code === "CLIENT_CANCELLED";
        persistedAssistantMessageId = messageId;
        hasServerPersistedAssistantMessage =
          errorInput.serverPersisted === true;
        streamingAssistantMessageId = messageId;
        if (
          streamingAssistantMessage &&
          streamingAssistantMessage.id !== previousAssistantMessageId
        ) {
          streamingAssistantMessage = {
            ...streamingAssistantMessage,
            id: previousAssistantMessageId,
          };
        }
        updateStreamingAssistantMessage((message) => ({
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
            toolCalls: [...streamToolCallsById.values()].filter((toolCall) =>
              shouldRenderToolCall(toolCall, [
                ...streamThinkingStepsById.values(),
              ]),
            ),
            thinkingSteps: [...streamThinkingStepsById.values()],
            renderBlocks: streamRenderBuffer.snapshotRenderBlocks(),
            threadRun: {
              ...(toObjectRecord(message.metadata.threadRun) ?? {}),
              idempotencyKey: durableRunKey,
              status: isClientCancelled ? "cancelled" : "failed",
              mode: input.mode,
            },
          },
        }));
        commitStreamingAssistantMessage();
      };

      try {
        const requestBody = buildStreamingThreadRequestBody({
          mode: input.mode,
          mentionedSourceIds: input.mentionedSourceIds,
          sourceIds: input.sourceIds,
          timezone: resolveClientTimezone(),
          durableRunKey,
          command: input.command,
          skillIds: input.skillIds,
          searchEnabled: input.searchEnabled ?? searchEnabled,
          tools: input.tools,
          thinking: input.thinking,
          byokSelections: input.byokSelections,
          selectedByokModels,
          selectedModels,
          catalogKindEnabled,
          streamWithSelectedLlm,
          thinkingSettings,
          attachOnly: input.attachOnly,
          content: input.content,
          images: input.images,
          userMessageId: input.userMessageId,
          assistantMessageId: input.assistantMessageId,
        });

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

        const streamEventParser = createStreamingEventParser<StreamEventPayload>(
          {
            parseEvent: (input) => input as StreamEventPayload,
          },
        );
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
            while (!streamEnded || streamRenderBuffer.hasQueuedDeltas()) {
              if (!streamRenderBuffer.hasQueuedDeltas()) {
                await waitForAnimationFrame();
                continue;
              }

              const nextDeltaBatch =
                streamRenderBuffer.consumeQueuedDeltaBatch();
              if (!nextDeltaBatch) {
                continue;
              }

              assistantText += nextDeltaBatch;
              streamRenderBuffer.appendText(nextDeltaBatch);
              latestAssistantMessageContent = assistantText;
              updateStreamingAssistantMessage((message) => ({
                ...message,
                content: assistantText,
                metadata: {
                  ...message.metadata,
                  renderBlocks: streamRenderBuffer.snapshotRenderBlocks(),
                  threadRun: {
                    ...(toObjectRecord(message.metadata.threadRun) ?? {}),
                    idempotencyKey: durableRunKey,
                    status: "running",
                    mode: input.mode,
                  },
                },
              }));

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

          streamRenderBuffer.enqueueDelta(delta);
        };

        const syncStreamingToolCalls = () => {
          const thinkingSteps = [...streamThinkingStepsById.values()];
          const toolCalls = [...streamToolCallsById.values()].filter(
            (toolCall) => shouldRenderToolCall(toolCall, thinkingSteps),
          );
          const shouldShowTextPause =
            assistantText.length > 0 &&
            toolCalls.some((toolCall) => toolCall.status === "running");
          updateStreamingAssistantMessage((message) => ({
            ...message,
            metadata: {
              ...message.metadata,
              [STREAM_TEXT_PAUSED_KEY]: shouldShowTextPause,
              toolCalls,
              renderBlocks: streamRenderBuffer.snapshotRenderBlocks(),
              threadRun: {
                ...(toObjectRecord(message.metadata.threadRun) ?? {}),
                idempotencyKey: durableRunKey,
                status: "running",
                mode: input.mode,
              },
            },
          }));
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
          updateStreamingAssistantMessage((message) => ({
            ...message,
            metadata: {
              ...message.metadata,
              [STREAM_TEXT_PAUSED_KEY]: shouldShowTextPause,
              thinkingSteps,
              toolCalls,
              renderBlocks: streamRenderBuffer.snapshotRenderBlocks(),
              threadRun: {
                ...(toObjectRecord(message.metadata.threadRun) ?? {}),
                idempotencyKey: durableRunKey,
                status: "running",
                mode: input.mode,
              },
            },
          }));
        };

        const syncStreamingCitations = (citationInput: {
          citations: CitationRecord[];
          availableCitations?: CitationRecord[];
        }) => {
          updateStreamingAssistantMessage((message) => ({
            ...message,
            metadata: {
              ...message.metadata,
              retrieval: {
                ...(toObjectRecord(message.metadata.retrieval) ?? {}),
                citations: citationInput.citations,
                availableCitations:
                  citationInput.availableCitations ?? citationInput.citations,
              },
              threadRun: {
                ...(toObjectRecord(message.metadata.threadRun) ?? {}),
                idempotencyKey: durableRunKey,
                status: "running",
                mode: input.mode,
              },
            },
          }));
        };

        const streamingEventHandlerContext =
          createStreamingEventHandlerContext({
            appendReasoningChunk,
            durableRunKey,
            isCompletedImageArtifactToolCall: (toolCall, event) =>
              isCompletedImageArtifactToolCall(
                toolCall,
                event as StreamEventPayload & { type: ToolCallEventType },
              ),
            isCompletedWorkfileWriteToolCall: (toolCall, event) =>
              isCompletedWorkfileWriteToolCall(
                toolCall,
                event as StreamEventPayload & { type: ToolCallEventType },
              ),
            isGeneratedImageArtifactToolName,
            mergeThinkingStepRecords,
            mode: input.mode,
            normalizeCitationRecords,
            normalizeModelReasoningSegmentRecord,
            normalizeThinkingStepRecord,
            normalizeThreadCommandRequest,
            resolveToolCallFromStreamEvent: ({ event, streamToolCallsById }) =>
              resolveToolCallFromStreamEvent({
                event: event as StreamEventPayload & {
                  type: ToolCallEventType;
                },
                streamToolCallsById,
              }),
            streamRenderBuffer,
            streamThinkingStepsById,
            streamToolCallsById,
            syncStreamingCitations,
            syncStreamingThinkingSteps,
            syncStreamingToolCalls,
            toNullableString,
            toObjectRecord,
            updateChatTitle,
            updateStreamingAssistantMessage,
          });

        readLoop: while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          for (const data of streamEventParser.parseChunk(value)) {
            if (data.type === "start" && typeof data.messageId === "string") {
              handleStreamingStart({
                context: streamingEventHandlerContext,
                event: {
                  ...data,
                  messageId: data.messageId,
                },
                tempUserId,
                setMessages,
                setPreparedEffectiveSourceIds: (sourceIds) => {
                  preparedEffectiveSourceIds = sourceIds;
                },
                setPersistedUserMessageId: (messageId) => {
                  persistedUserMessageId = messageId;
                },
                setCreatedUserMessageId: (messageId) => {
                  if (createdUserMessageId === tempUserId) {
                    createdUserMessageId = messageId;
                  }
                },
              });
            } else if (
              data.type === "text-delta" &&
              typeof data.delta === "string"
            ) {
              handleStreamingTextDelta({
                context: streamingEventHandlerContext,
                assistantText,
                delta: data.delta,
                enqueueDelta,
                startDeltaDrain,
              });
            } else if (
              data.type === "text-replace" &&
              typeof data.text === "string"
            ) {
              handleStreamingTextReplace({
                context: streamingEventHandlerContext,
                text: data.text,
                setAssistantText: (text) => {
                  assistantText = text;
                },
                setLatestAssistantMessageContent: (content) => {
                  latestAssistantMessageContent = content;
                },
                setHasRenderedDelta: (nextHasRenderedDelta) => {
                  hasRenderedDelta = nextHasRenderedDelta;
                },
              });
            } else if (data.type === "text-interrupted") {
              handleStreamingTextInterrupted({
                context: streamingEventHandlerContext,
              });
            } else if (isToolCallEvent(data)) {
              handleStreamingToolCallEvent({
                context: streamingEventHandlerContext,
                event: data,
                drainQueuedDeltasNow,
                refreshedArtifactToolIds,
                refreshedWorkfileToolIds,
                setArtifactsRefreshKey,
                setWorkfilesRefreshKey,
              });
            } else if (data.type === "thinking-step") {
              handleStreamingThinkingStep({
                context: streamingEventHandlerContext,
                step: data.step,
              });
            } else if (
              data.type === "reasoning" &&
              typeof data.reasoning === "string"
            ) {
              handleStreamingReasoning({
                context: streamingEventHandlerContext,
                reasoning: data.reasoning,
                segment: data.segment,
              });
            } else if (data.type === "citations") {
              handleStreamingCitations({
                context: streamingEventHandlerContext,
                citations: data.citations,
                availableCitations: data.availableCitations,
              });
            } else if (
              data.type === "thread-title-update" &&
              typeof data.threadId === "string" &&
              typeof data.title === "string"
            ) {
              handleStreamingThreadTitleUpdate({
                context: streamingEventHandlerContext,
                threadId: data.threadId,
                title: data.title,
              });
              shouldPollThreadTitle = false;
            } else if (
              data.type === "thread-title-pending" &&
              typeof data.threadId === "string"
            ) {
              handleStreamingThreadTitlePending({
                eventThreadId: data.threadId,
                jobId: data.jobId,
                threadId,
                setShouldPollThreadTitle: (shouldPoll) => {
                  shouldPollThreadTitle = shouldPoll;
                },
                setPendingTitleJobId: (jobId) => {
                  pendingTitleJobId = jobId;
                },
              });
            } else if (data.type === "error") {
              handleStreamingError({
                event: data,
                persistedUserMessageId,
                markStreamingAssistantAsError,
                setSuppressErrorToast: (nextSuppressErrorToast) => {
                  suppressErrorToast = nextSuppressErrorToast;
                },
                setStreamError: (error) => {
                  streamError = error;
                },
              });
            } else if (
              data.type === "assistant-message" &&
              typeof data.messageId === "string"
            ) {
              handleStreamingAssistantMessage({
                context: streamingEventHandlerContext,
                messageId: data.messageId,
                parentMessageId: data.parentMessageId,
                userMessageId: data.userMessageId,
                persistedUserMessageId,
                streamingAssistantMessage,
                streamingAssistantMessageId,
                streamingAssistantMessageIds,
                setPersistedAssistantMessageId: (messageId) => {
                  persistedAssistantMessageId = messageId;
                },
                setStreamingAssistantMessageId: (messageId) => {
                  streamingAssistantMessageId = messageId;
                },
                setStreamingAssistantMessage: (message) => {
                  streamingAssistantMessage = message;
                },
              });
            } else if (data.type === "finish") {
              const finishState = handleStreamingFinish({
                context: streamingEventHandlerContext,
              });
              receivedFinishEvent = finishState.receivedFinishEvent;
              streamEnded = finishState.streamEnded;
              break readLoop;
            }
          }
        }

        streamEnded = true;
        if (drainPromise) {
          await drainPromise;
        }
        commitStreamingAssistantMessage();

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
        clearRunIfCurrent(durableRunKey);
        clearAttachedRunKeyIfCurrent(durableRunKey);
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
                  !streamingAssistantMessageIds.has(message.id) &&
                  message.id !== streamingAssistantMessage?.id &&
                  (!createdUserMessageId ||
                    message.id !== createdUserMessageId),
              );
              return withoutFailedTemporaryMessages;
            });
            setStreamingAssistantSnapshot(null);
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
        markRunTerminal({ detachedWithoutFinish, durableRunKey });
      }
    },
    [
      catalogKindEnabled.image,
      catalogKindEnabled.llm,
      catalogKindEnabled.vision,
      clearEditingState,
      clearAttachedRunKeyIfCurrent,
      clearRunIfCurrent,
      loadThreadMessages,
      librarySources,
      markRunStarted,
      markRunTerminal,
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

  useEffect(() => {
    clearEditingState();
    setActiveVersionByGroup({});
    setDisplayedCitations([]);
    setStreamingAssistantSnapshot(null);
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
          <div className="flex min-h-16 flex-wrap items-start justify-between gap-2 px-3 py-2 md:h-16 md:flex-nowrap md:items-center md:gap-3 md:px-6 md:py-0 xl:px-8">
            <div className="flex min-w-0 flex-1 self-stretch items-center gap-2 overflow-hidden md:gap-2.5">
              <div className="shrink-0 md:hidden">
                <SidebarTrigger />
              </div>
              <div className="flex min-w-0 flex-1 items-center md:flex-none">
                <h1 className="truncate text-base leading-none font-semibold text-foreground">
                  {threadTitle}
                </h1>
              </div>
            </div>

            <div className="contents md:ml-auto md:flex md:h-10 md:shrink-0 md:items-center md:gap-2">
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
              <Button
                className="size-8 md:h-10 md:w-10 md:border-border/60 md:bg-background md:shadow-xs"
                onClick={() => {
                  if (isPersistentLayout) {
                    toggleSourcesVisible();
                    return;
                  }
                  setHubDrawerOpen(true);
                }}
                size="icon-sm"
                title={
                  isPersistentLayout
                    ? sourcesVisible
                      ? "Hide sources"
                      : "Show sources"
                    : "Open Hub"
                }
                type="button"
                variant="outline"
              >
                {isPersistentLayout && sourcesVisible ? (
                  <PanelRightClose className="h-4 w-4" />
                ) : (
                  <PanelRightOpen className="h-4 w-4" />
                )}
                <span className="sr-only">
                  {isPersistentLayout
                    ? sourcesVisible
                      ? "Hide sources"
                      : "Show sources"
                    : "Open Hub"}
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
          hasOlderMessages={Boolean(olderMessagesCursor)}
          isEditing={Boolean(editingMessageId && editingGroupId)}
          isLoadingOlderMessages={isLoadingOlderMessages}
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
          onLoadOlderMessages={() => void loadOlderThreadMessages()}
          thinkingSettings={thinkingSettings}
          onThinkingSettingsChange={handleThinkingSettingsChange}
          threadTitle={threadTitle}
          workspaceId={workspaceId}
        />
      </div>

      {sourcesVisible && isPersistentLayout && !previewArtifact ? (
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
          onSourceMerge={handleLibrarySourcesMerge}
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

      <Sheet open={hubDrawerOpen} onOpenChange={setHubDrawerOpen}>
        <SheetContent
          className="w-[calc(100vw-1rem)] max-w-[360px] gap-0 overflow-hidden p-0 sm:w-[380px] sm:max-w-[380px] [&>button]:hidden"
          side="right"
        >
          <SheetTitle className="sr-only">Hub</SheetTitle>
          <SourcesHub
            activeCitationIndex={activeCitationIndex}
            artifactsRefreshKey={artifactsRefreshKey}
            citations={displayedCitations}
            currentCitationMessageId={activeAssistantVersion?.id ?? null}
            disabledToolNames={disabledToolNames}
            installedSkills={availableSkills}
            mode="thread"
            onClose={() => setHubDrawerOpen(false)}
            onArtifactOpen={(artifact) => {
              setPreviewArtifact(artifact);
              setHubDrawerOpen(false);
            }}
            onCitationLocate={scrollToMessage}
            onCitationOpen={handleSourceHubCitationOpen}
            initialSources={initialSourcesForWorkspace}
            initialSourcesLoaded={hasCachedWorkspaceSources(workspaceId)}
            onSkillSelectionChange={setActiveSkillIds}
            onSelectionChange={persistActiveSourceIds}
            onSkillsCatalogChange={loadAvailableSkills}
            onSourceLoad={handleLibrarySourcesLoad}
            onSourceMerge={handleLibrarySourcesMerge}
            selectedIds={activeSourceIds}
            selectedSkillIds={activeSkillIds}
            threadCitations={threadCitations}
            threadId={threadId}
            variant="drawer"
            workfilesRefreshKey={workfilesRefreshKey}
            workspaceId={workspaceId}
            workspaceName={workspaceName}
          />
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
