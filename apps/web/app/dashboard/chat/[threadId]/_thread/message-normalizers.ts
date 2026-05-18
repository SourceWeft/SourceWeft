import {
  HttpClientError,
  isGeneratedImageArtifactToolName,
  isWorkfileWriteToolName,
  SOURCEWEFT_WEB_RUN_IDEMPOTENCY_PREFIX,
} from "@sourceweft/sdk";
import type {
  ChatSendInput,
  CitationRecord,
  MessageRenderBlock,
  ModelReasoningSegmentRecord,
  ThinkingStepRecord,
  ToolCallRecord,
} from "../../_components/chat-canvas";
import type { contentClient } from "../../../../../lib/sdk";
import type { ChatStreamEventPayload, ChatStreamToolCallEventType } from "../chat-stream-runner";
import type { ActiveThreadRun } from "../chat-stream-runner-control";
import type { ChatMessageItem } from "../streaming-assistant-state";

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

const THREAD_MESSAGES_LOAD_RETRY_DELAYS_MS = [300, 1000, 2500] as const;

const THREAD_MESSAGES_INITIAL_PAGE_SIZE = 80;

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
    setTimeout(resolve, delayMs);
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

function resolveToolCallFromStreamEvent(input: {
  event: ChatStreamEventPayload & { type: ChatStreamToolCallEventType };
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
  event: ChatStreamEventPayload & { type: ChatStreamToolCallEventType },
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
  event: ChatStreamEventPayload & { type: ChatStreamToolCallEventType },
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

export {
  appendReasoningChunk,
  basename,
  createActiveThreadRunPlaceholder,
  createDurableRunKey,
  findLatestActiveThreadRunMessage,
  formatBytes,
  getDisplayErrorMessage,
  isCompletedImageArtifactToolCall,
  isCompletedWorkfileWriteToolCall,
  mapThreadMessagesToChatMessages,
  mergeThinkingStepRecords,
  normalizeCitationRecords,
  normalizeModelReasoningSegmentRecord,
  normalizeThinkingStepRecord,
  normalizeThreadCommandRequest,
  resolveCitationMetadata,
  resolveModelReasoningFromMetadata,
  resolveModelReasoningSegmentsFromMetadata,
  resolveRenderBlocksFromMetadata,
  resolveThinkingStepsFromMetadata,
  resolveToolCallFromStreamEvent,
  resolveToolCallsFromMetadata,
  shouldRenderToolCall,
  shouldRetryThreadMessagesLoad,
  STREAM_RENDER_KEY,
  STREAM_TEXT_INTERRUPTED_KEY,
  STREAM_TEXT_PAUSED_KEY,
  THREAD_MESSAGES_INITIAL_PAGE_SIZE,
  THREAD_MESSAGES_LOAD_RETRY_DELAYS_MS,
  throwStreamRequestError,
  toNullableString,
  toObjectRecord,
  waitForThreadMessagesRetry,
  workfilePurposeLabel,
};
export type { ThreadMessageItem, WorkfileDetail };
