import {
  HttpClientError,
  SOURCEWEFT_WEB_RUN_IDEMPOTENCY_PREFIX,
  type ToolApprovalResume,
} from "@sourceweft/sdk";
import {
  getAgentToolConnectorType,
  getAgentToolPresentation,
  getAgentToolRenderAs,
  getArtifactProgressProtocol,
  hasAgentToolCapability,
  isAgentToolDomain,
} from "@sourceweft/agent-tool-registry";
import { isPendingToolConfirmation } from "@sourceweft/contracts";
import { readArtifactOutputField } from "@sourceweft/contracts/artifact-progress";
import type {
  ChatSendInput,
  CitationRecord,
  MessageRenderBlock,
  ModelReasoningSegmentRecord,
  ReasoningTraceEventRecord,
  ThinkingStepRecord,
  ToolCallRecord,
  TracePartRecord,
} from "../../_components/chat-canvas";
import type { contentClient } from "../../../../../lib/sdk";
import type {
  ChatStreamEventPayload,
  ChatStreamToolCallEventType,
} from "../chat-stream-runner";
import type { ActiveThreadRun } from "../chat-stream-runner-control";
import type { ChatMessageItem } from "../streaming-assistant-state";

type ThreadMessageItem = Awaited<
  ReturnType<typeof contentClient.listThreadMessages>
>["items"][number];

type WorkfileDetail = Awaited<
  ReturnType<typeof contentClient.getWorkingFile>
>["file"];

function mapThreadMessagesToChatMessages(messages: ThreadMessageItem[]) {
  const normalizedMessages = messages
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
  return dropStaleActiveThreadRunMessages(normalizedMessages);
}

const STREAM_TEXT_PAUSED_KEY = "isTextPaused";

const STREAM_TEXT_INTERRUPTED_KEY = "isTextInterrupted";

const STREAM_RENDER_KEY = "renderKey";

const THREAD_MESSAGES_LOAD_RETRY_DELAYS_MS = [300, 1000, 2500] as const;

const THREAD_MESSAGES_INITIAL_PAGE_SIZE = 80;

function normalizeApprovalState(
  value: unknown,
): ToolCallRecord["approvalState"] {
  return value === "approved" || value === "rejected" ? value : undefined;
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

function getDisplayErrorMessage(error: unknown) {
  if (!(error instanceof Error)) {
    return "Failed to send message.";
  }
  return sanitizeClientErrorMessage(error.message) ?? "Failed to send message.";
}

export function sanitizeClientErrorMessage(value: string | null | undefined) {
  const text = value?.trim();
  if (!text) {
    return null;
  }
  if (
    /Error invoking tool/i.test(text) ||
    /Received tool input did not match expected schema/i.test(text) ||
    /\bkwargs\b/i.test(text) ||
    /Invalid input: expected .*received/i.test(text)
  ) {
    const toolName =
      text.match(/tool ['"]([^'"]+)['"]/i)?.[1] ??
      text.match(/\btool[=:]\s*([A-Za-z0-9_-]+)/i)?.[1];
    return toolName
      ? `${toolName} failed because the generated tool arguments were invalid. Please retry.`
      : "The generated tool arguments were invalid. Please retry.";
  }
  return text.length > 600 ? `${text.slice(0, 597).trimEnd()}...` : text;
}

type ApiErrorPayload = {
  code?: unknown;
  message?: unknown;
};

class StreamRequestError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(input: {
    status: number;
    code?: string | null;
    message: string;
  }) {
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
  const payload = (await response
    .json()
    .catch(() => null)) as ApiErrorPayload | null;
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
  const kind = rawKind === "tool" || rawKind === "skill" ? rawKind : undefined;
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
  if (isTerminalMessageMetadata(metadata)) {
    return null;
  }

  const threadRun = toObjectRecord(metadata.threadRun);
  const idempotencyKey = toNullableString(threadRun?.idempotencyKey);
  const status = toNullableString(threadRun?.status);
  if (
    !idempotencyKey?.startsWith(SOURCEWEFT_WEB_RUN_IDEMPOTENCY_PREFIX) ||
    (status !== "queued" &&
      status !== "running" &&
      status !== "cancel_requested" &&
      status !== "waiting_for_approval")
  ) {
    return null;
  }

  const mode = toNullableString(threadRun?.mode);
  return {
    id: toNullableString(threadRun?.id) ?? undefined,
    assistantMessageId: toNullableString(threadRun?.assistantMessageId),
    idempotencyKey,
    status,
    userMessageId: toNullableString(threadRun?.userMessageId),
    approvalRequestedAt: toNullableString(threadRun?.approvalRequestedAt),
    approvalExpiresAt: toNullableString(threadRun?.approvalExpiresAt),
    mode:
      mode === "send" ||
      mode === "refresh" ||
      mode === "edit" ||
      mode === "resume"
        ? mode
        : undefined,
  } satisfies ActiveThreadRun;
}

function isTerminalMessageMetadata(metadata: Record<string, unknown>) {
  if (
    metadata.isError === true ||
    metadata.isCancelled === true ||
    typeof metadata.errorCode === "string"
  ) {
    return true;
  }

  const threadRun = toObjectRecord(metadata.threadRun);
  const status = toNullableString(threadRun?.status);
  if (status === "completed" || status === "failed" || status === "cancelled") {
    return true;
  }

  const finishReason = toNullableString(metadata.finishReason);
  return Boolean(
    finishReason && finishReason !== "tool_confirmation_requested",
  );
}

function getThreadRunIdentities(metadata: Record<string, unknown>) {
  const threadRun = toObjectRecord(metadata.threadRun);
  const id = toNullableString(threadRun?.id);
  const idempotencyKey = toNullableString(threadRun?.idempotencyKey);
  return [id, idempotencyKey].filter((value): value is string =>
    Boolean(value),
  );
}

function hasActiveThreadRunStatus(metadata: Record<string, unknown>) {
  const threadRun = toObjectRecord(metadata.threadRun);
  const status = toNullableString(threadRun?.status);
  return (
    status === "queued" ||
    status === "running" ||
    status === "cancel_requested" ||
    status === "waiting_for_approval"
  );
}

function dropStaleActiveThreadRunMessages(messages: ChatMessageItem[]) {
  const terminalThreadRuns = new Set<string>();
  for (const message of messages) {
    if (
      message.role !== "assistant" ||
      !isTerminalMessageMetadata(message.metadata)
    ) {
      continue;
    }
    for (const identity of getThreadRunIdentities(message.metadata)) {
      terminalThreadRuns.add(identity);
    }
  }

  if (terminalThreadRuns.size === 0) {
    return messages;
  }

  return messages.filter((message) => {
    if (
      message.role !== "assistant" ||
      isTerminalMessageMetadata(message.metadata) ||
      !hasActiveThreadRunStatus(message.metadata)
    ) {
      return true;
    }
    return !getThreadRunIdentities(message.metadata).some((identity) =>
      terminalThreadRuns.has(identity),
    );
  });
}

function findActiveThreadRunMessage(
  messages: ChatMessageItem[],
  activeRun: ActiveThreadRun | null | undefined,
) {
  if (!activeRun) {
    return null;
  }

  for (const message of [...messages].reverse()) {
    if (message.role !== "assistant") {
      continue;
    }

    const run = resolveThreadRunMetadata(message.metadata);
    if (!run) {
      continue;
    }

    const matchesRun =
      (Boolean(activeRun.assistantMessageId) &&
        activeRun.assistantMessageId === message.id) ||
      (Boolean(activeRun.id) && Boolean(run.id) && activeRun.id === run.id) ||
      run.idempotencyKey === activeRun.idempotencyKey;
    if (!matchesRun) {
      continue;
    }

    return {
      message,
      run: {
        ...activeRun,
        assistantMessageId:
          activeRun.assistantMessageId ?? run.assistantMessageId ?? message.id,
      },
    };
  }

  return null;
}

function findLatestActiveThreadRunMessage(messages: ChatMessageItem[]) {
  for (const message of [...messages].reverse()) {
    if (message.role !== "assistant") {
      continue;
    }

    const run = resolveThreadRunMetadata(message.metadata);
    if (run) {
      return {
        message,
        run: {
          ...run,
          assistantMessageId: run.assistantMessageId ?? message.id,
        },
      };
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
        assistantMessageId: input.run.assistantMessageId,
        idempotencyKey: input.run.idempotencyKey,
        status: input.run.status,
        mode: input.run.mode,
        approvalRequestedAt: input.run.approvalRequestedAt,
        approvalExpiresAt: input.run.approvalExpiresAt,
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
  return value === "running" ||
    value === "approval_requested" ||
    value === "completed" ||
    value === "error"
    ? value
    : fallback;
}

function isConnectorToolName(toolName: string) {
  return isAgentToolDomain(toolName, "connector");
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
  const output = normalizePublicToolOutput(
    tool,
    normalizeToolOutput(record.output),
  );
  const confirmation = getToolConfirmationRecord(output);
  const normalizedStatus =
    status === "completed" && isPendingToolConfirmation(confirmation)
      ? "approval_requested"
      : status;

  return {
    id,
    tool,
    input: isConnectorToolName(tool)
      ? {}
      : (toObjectRecord(record.input) ?? {}),
    output,
    latencyMs: toNullableNumber(record.latencyMs),
    status: normalizedStatus,
    error: sanitizeClientErrorMessage(toNullableString(record.error)),
    sequence: toNullableNumber(record.sequence) ?? undefined,
    approvalState: normalizeApprovalState(record.approvalState),
    approvalConfirmationId:
      toNullableString(record.approvalConfirmationId) ?? undefined,
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

function parseJsonObjectString(value: string) {
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

function getToolMessageContentRecord(output: unknown) {
  const record = toObjectRecord(output);
  const content = typeof record?.content === "string" ? record.content : null;
  return content ? parseJsonObjectString(content) : null;
}

function getToolConfirmationRecord(output: unknown) {
  const record = toObjectRecord(output);
  if (record?.type === "tool_confirmation_request") {
    return record;
  }

  const contentRecord = getToolMessageContentRecord(output);
  return contentRecord?.type === "tool_confirmation_request"
    ? contentRecord
    : null;
}

function normalizePublicToolConfirmationOutput(
  confirmation: Record<string, unknown>,
) {
  const preview = toObjectRecord(confirmation.preview);
  const normalized = {
    ...confirmation,
    preview: preview
      ? Object.fromEntries(
          Object.entries(preview).filter(([key]) => key !== "requestJson"),
        )
      : confirmation.preview,
  } as Record<string, unknown>;
  delete normalized.editableArgs;
  return normalized;
}

/**
 * Unwrap a deliverable's structured progress output. Which `type` values count
 * comes from the capability's own progress protocol, so this stays correct as
 * capabilities are added.
 */
function normalizeDeliverablePublicToolOutput(
  toolName: string,
  output: unknown,
) {
  const record = toObjectRecord(output);
  const contentRecord = getToolMessageContentRecord(output);
  const publicRecord = contentRecord ?? record;
  const type = toNullableString(publicRecord?.type)?.trim();
  return getArtifactProgressProtocol(toolName)?.outputTypes.includes(type ?? "")
    ? publicRecord
    : output;
}

function normalizePublicToolOutput(toolName: string, output: unknown) {
  const confirmation = getToolConfirmationRecord(output);
  if (confirmation) {
    return normalizePublicToolConfirmationOutput(confirmation);
  }

  if (getArtifactProgressProtocol(toolName)) {
    return normalizeDeliverablePublicToolOutput(toolName, output);
  }

  if (!isConnectorToolName(toolName)) {
    return output;
  }

  const record = toObjectRecord(output);
  const contentRecord = getToolMessageContentRecord(output);
  const publicRecord = contentRecord ?? record;
  if (publicRecord?.type === "connector_tool_error") {
    return publicRecord;
  }
  const actionType = toNullableString(publicRecord?.actionType)?.trim();
  const outputToolName =
    toNullableString(publicRecord?.toolName)?.trim() ?? toolName;
  const title = toNullableString(publicRecord?.title)?.trim();
  const url = toNullableString(publicRecord?.url)?.trim();
  const pageId = toNullableString(publicRecord?.pageId)?.trim();
  const query = toNullableString(publicRecord?.query)?.trim();
  const resultCount = toNullableNumber(publicRecord?.resultCount);
  const pages = normalizePublicConnectorPages(publicRecord?.pages);
  const connectorType =
    getAgentToolConnectorType(toolName) ??
    getAgentToolConnectorType(outputToolName) ??
    "connector";
  return {
    type: "connector_tool_result",
    connector: connectorType,
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

function normalizePublicConnectorPages(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      const record = toObjectRecord(item);
      if (!record) {
        return null;
      }
      const pageId = toNullableString(record.pageId)?.trim();
      const title = toNullableString(record.title)?.trim();
      const url = toNullableString(record.url)?.trim();
      const lastEditedTime = toNullableString(record.lastEditedTime)?.trim();
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

function completeRunningThinkingStep(
  step: ThinkingStepRecord,
): ThinkingStepRecord {
  if (step.status !== "in_progress") {
    return step;
  }
  return {
    ...step,
    status: "completed",
  };
}

function terminalizeThinkingStepRecord(
  step: ThinkingStepRecord,
  isTerminal: boolean,
): ThinkingStepRecord {
  return isTerminal ? completeRunningThinkingStep(step) : step;
}

function terminalizeTracePartRecord(
  part: TracePartRecord,
  isTerminal: boolean,
): TracePartRecord {
  if (!isTerminal || part.kind !== "step" || part.status !== "in_progress") {
    return part;
  }
  return {
    ...part,
    status: "completed",
  };
}

function resolveThinkingStepsFromMetadata(metadata: Record<string, unknown>) {
  if (!Array.isArray(metadata.thinkingSteps)) {
    return [] as ThinkingStepRecord[];
  }

  const isTerminal = isTerminalMessageMetadata(metadata);
  return metadata.thinkingSteps
    .map((item) => normalizeThinkingStepRecord(item))
    .filter((item): item is ThinkingStepRecord => item !== null)
    .map((step) => terminalizeThinkingStepRecord(step, isTerminal));
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
    phase:
      record.phase === "initial" || record.phase === "after_tool"
        ? record.phase
        : undefined,
    toolCallId: toNullableString(record.toolCallId) ?? undefined,
    tool: toNullableString(record.tool) ?? undefined,
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

function normalizeReasoningTraceEventRecord(
  value: unknown,
): ReasoningTraceEventRecord | null {
  const record = toObjectRecord(value);
  if (!record) {
    return null;
  }

  const id = toNullableString(record.id);
  if (!id) {
    return null;
  }

  const sequence = toNullableNumber(record.sequence) ?? undefined;
  const displayOrder = toNullableNumber(record.displayOrder) ?? undefined;
  const itemId = toNullableString(record.itemId) ?? undefined;
  if (record.type === "reasoning") {
    const segment = normalizeModelReasoningSegmentRecord(record.segment);
    return segment
      ? {
          type: "reasoning",
          id,
          displayOrder,
          itemId,
          sequence,
          reasoning: toNullableString(record.reasoning) ?? undefined,
          segment,
        }
      : null;
  }

  if (record.type === "tool-call") {
    const toolCall = normalizeToolCallRecord(record.toolCall);
    return {
      type: "tool-call",
      id,
      displayOrder,
      itemId,
      sequence,
      eventType: toNullableString(record.eventType) ?? undefined,
      tool: toNullableString(record.tool) ?? toolCall?.tool,
      toolCall: toolCall ?? undefined,
      payload: toObjectRecord(record.payload) ?? undefined,
    };
  }

  if (record.type === "thinking-step") {
    const step = normalizeThinkingStepRecord(record.step);
    return step
      ? {
          type: "thinking-step",
          id,
          displayOrder,
          itemId,
          sequence,
          step,
        }
      : null;
  }

  return null;
}

function resolveReasoningTraceEventsFromMetadata(
  metadata: Record<string, unknown>,
) {
  if (!Array.isArray(metadata.traceEvents)) {
    return [] as ReasoningTraceEventRecord[];
  }

  const isTerminal = isTerminalMessageMetadata(metadata);
  return metadata.traceEvents
    .map((item) => normalizeReasoningTraceEventRecord(item))
    .filter((item): item is ReasoningTraceEventRecord => item !== null)
    .map((event) => {
      if (!isTerminal || event.type !== "thinking-step") {
        return event;
      }
      return {
        ...event,
        step: terminalizeThinkingStepRecord(event.step, true),
      };
    });
}

function normalizeTracePartRecord(value: unknown): TracePartRecord | null {
  const record = toObjectRecord(value);
  if (!record) {
    return null;
  }
  const id = toNullableString(record.id);
  const order = toNullableNumber(record.order);
  const createdAt = toNullableString(record.createdAt);
  const updatedAt = toNullableString(record.updatedAt);
  if (!id || order === null || !createdAt || !updatedAt) {
    return null;
  }

  if (record.kind === "reasoning") {
    const text = toNullableString(record.text);
    if (!text) {
      return null;
    }
    return {
      id,
      kind: "reasoning",
      order,
      createdAt,
      updatedAt,
      text,
      phase:
        record.phase === "initial" || record.phase === "after_tool"
          ? record.phase
          : undefined,
      toolCallId: toNullableString(record.toolCallId) ?? undefined,
      tool: toNullableString(record.tool) ?? undefined,
      durationMs: toNullableNumber(record.durationMs) ?? undefined,
    };
  }

  if (record.kind === "tool") {
    const toolCallId = toNullableString(record.toolCallId);
    const tool = toNullableString(record.tool);
    const status = record.status;
    if (
      !toolCallId ||
      !tool ||
      (status !== "running" &&
        status !== "approval_requested" &&
        status !== "completed" &&
        status !== "error")
    ) {
      return null;
    }
    return {
      id,
      kind: "tool",
      order,
      createdAt,
      updatedAt,
      toolCallId,
      tool,
      status,
      input: toObjectRecord(record.input) ?? {},
      output: record.output,
      error:
        typeof record.error === "string" || record.error === null
          ? record.error
          : undefined,
      latencyMs:
        record.latencyMs === null
          ? null
          : (toNullableNumber(record.latencyMs) ?? undefined),
      title: toNullableString(record.title) ?? undefined,
      approvalState: normalizeApprovalState(record.approvalState),
      approvalConfirmationId:
        toNullableString(record.approvalConfirmationId) ?? undefined,
    };
  }

  if (record.kind === "step") {
    const title = toNullableString(record.title);
    const status = record.status;
    if (
      !title ||
      (status !== "pending" &&
        status !== "in_progress" &&
        status !== "completed")
    ) {
      return null;
    }
    return {
      id,
      kind: "step",
      order,
      createdAt,
      updatedAt,
      title,
      status,
      items: Array.isArray(record.items)
        ? record.items.filter(
            (item): item is string => typeof item === "string",
          )
        : [],
      metadata: toObjectRecord(record.metadata) ?? undefined,
    };
  }

  return null;
}

function resolveTracePartsFromMetadata(metadata: Record<string, unknown>) {
  if (!Array.isArray(metadata.traceParts)) {
    return [] as TracePartRecord[];
  }

  const isTerminal = isTerminalMessageMetadata(metadata);
  return metadata.traceParts
    .map((item) => normalizeTracePartRecord(item))
    .filter((item): item is TracePartRecord => item !== null)
    .map((part) => terminalizeTracePartRecord(part, isTerminal))
    .sort((left, right) => left.order - right.order);
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

  const eventInput = isConnectorToolName(tool)
    ? null
    : toObjectRecord(input.event.input);
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
      (existing?.status === "completed" ||
        existing?.status === "approval_requested")
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
  const normalizedOutput = normalizePublicToolOutput(
    tool,
    normalizeToolOutput(mergedOutput),
  );

  const normalizedStatus = (() => {
    if (input.event.type === "tool-call-error") {
      return "error" as const;
    }

    if (input.event.type === "tool-call-result") {
      if (
        isPendingToolConfirmation(getToolConfirmationRecord(normalizedOutput))
      ) {
        return "approval_requested" as const;
      }
      return "completed" as const;
    }

    if (input.event.type === "tool-call-end") {
      if (
        isPendingToolConfirmation(getToolConfirmationRecord(normalizedOutput))
      ) {
        return "approval_requested" as const;
      }
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
      ? (sanitizeClientErrorMessage(toNullableString(input.event.error)) ??
        "Tool execution failed.")
      : normalizedStatus === "error"
        ? (sanitizeClientErrorMessage(existing?.error) ??
          "Tool execution failed.")
        : null);

  return {
    id: resolvedId,
    tool,
    input: normalizedInput,
    output: normalizedOutput,
    latencyMs: normalizedLatencyMs,
    status: normalizedStatus,
    error: normalizedError,
    approvalState: normalizedToolCall?.approvalState ?? existing?.approvalState,
    approvalConfirmationId:
      normalizedToolCall?.approvalConfirmationId ??
      existing?.approvalConfirmationId,
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
  return value === "/workfiles" || Boolean(value?.startsWith("/workfiles/"));
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
  return Boolean(content?.includes("/workfiles/"));
}

function isCompletedWorkfileWriteToolCall(
  toolCall: ToolCallRecord,
  event: ChatStreamEventPayload & { type: ChatStreamToolCallEventType },
) {
  if (toolCall.status !== "completed") {
    return false;
  }

  if (
    event.type !== "tool-call-result" &&
    !(event.type === "tool-call-end" && toolCall.status === "completed")
  ) {
    return false;
  }

  if (!hasAgentToolCapability(toolCall.tool, "workfile_write")) {
    return false;
  }

  return (
    isWorkPath(getToolCallPath(toolCall.input)) ||
    outputContainsWorkPath(toolCall.output)
  );
}

/**
 * Whether this event just left a finished artifact behind, so the artifact list
 * is worth re-reading.
 *
 * Capability-agnostic on purpose: a tool produces an artifact iff it declares a
 * renderAs, and whether that artifact is *ready* is answered by the capability's
 * own presentation. Adding a medium must not mean editing this file.
 */
function isCompletedArtifactToolCall(
  toolCall: ToolCallRecord,
  event: ChatStreamEventPayload & { type: ChatStreamToolCallEventType },
) {
  if (toolCall.status !== "completed" || toolCall.error) {
    return false;
  }

  if (
    event.type !== "tool-call-result" &&
    !(event.type === "tool-call-end" && toolCall.status === "completed")
  ) {
    return false;
  }

  if (!getAgentToolRenderAs(toolCall.tool)) {
    return false;
  }

  const presentation = getAgentToolPresentation(toolCall.tool);
  if (!presentation?.artifactCompletionPhase) {
    // No opinion means the artifact exists as soon as the call completes.
    return true;
  }

  return (
    presentation.artifactCompletionPhase({
      toolInput: toolCall.input,
      toolOutput: toolCall.output,
      readOutputField: readArtifactOutputField,
      status: toolCall.status,
    }) === "completed"
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

function getToolConfirmationId(output: unknown) {
  const record = toObjectRecord(output);
  return record?.type === "tool_confirmation_request" &&
    typeof record.id === "string"
    ? record.id
    : null;
}

function getResolvedToolConfirmationStatus(input: {
  confirmationId: string;
  confirmationIds: string[] | undefined;
  toolApprovalResume: ToolApprovalResume | null | undefined;
}) {
  const index = input.confirmationIds?.indexOf(input.confirmationId) ?? -1;
  if (index < 0) {
    return null;
  }

  const decision = input.toolApprovalResume?.decisions[index];
  if (!decision) {
    return null;
  }

  return decision.type === "reject" ? "rejected" : "approved";
}

function resolveToolConfirmationOutput(input: {
  output: unknown;
  status: "approved" | "rejected";
}) {
  const record = getToolConfirmationRecord(input.output);
  if (!record) {
    return input.output;
  }

  return normalizePublicToolConfirmationOutput({
    ...record,
    action: {
      ...(toObjectRecord(record.action) ?? {}),
      status: input.status,
    },
    status: input.status,
    userMessage:
      input.status === "rejected"
        ? "Approval rejected. The action was not run."
        : "Approval recorded. The action may now run.",
  });
}

function resolveToolConfirmationCall(input: {
  toolCall: ToolCallRecord;
  status: "approved" | "rejected";
}) {
  const confirmationId = getToolConfirmationId(input.toolCall.output);
  return {
    ...input.toolCall,
    output: resolveToolConfirmationOutput({
      output: input.toolCall.output,
      status: input.status,
    }),
    status: "completed" as const,
    approvalState: input.status,
    approvalConfirmationId:
      confirmationId ?? input.toolCall.approvalConfirmationId,
  };
}

function resolveTracePartToolConfirmation(input: {
  part: TracePartRecord;
  status: "approved" | "rejected";
}) {
  if (input.part.kind !== "tool") {
    return input.part;
  }
  const confirmationId = getToolConfirmationId(input.part.output);
  return {
    ...input.part,
    output: resolveToolConfirmationOutput({
      output: input.part.output,
      status: input.status,
    }),
    status: "completed" as const,
    approvalState: input.status,
    approvalConfirmationId: confirmationId ?? input.part.approvalConfirmationId,
    updatedAt: new Date().toISOString(),
  } satisfies TracePartRecord;
}

function excludeResolvedToolConfirmationCalls(
  toolCalls: ToolCallRecord[],
  confirmationIds: string[] | undefined,
) {
  if (!confirmationIds?.length) {
    return toolCalls;
  }
  const resolvedIds = new Set(confirmationIds);
  return toolCalls.filter((toolCall) => {
    const confirmationId = getToolConfirmationId(toolCall.output);
    return !confirmationId || !resolvedIds.has(confirmationId);
  });
}

function resolveToolConfirmationCalls(
  toolCalls: ToolCallRecord[],
  confirmationIds: string[] | undefined,
  toolApprovalResume?: ToolApprovalResume | null,
) {
  if (!confirmationIds?.length) {
    return toolCalls;
  }
  return toolCalls.map((toolCall) => {
    const confirmationId = getToolConfirmationId(toolCall.output);
    if (!confirmationId) {
      return toolCall;
    }
    const status = getResolvedToolConfirmationStatus({
      confirmationId,
      confirmationIds,
      toolApprovalResume,
    });
    return status
      ? resolveToolConfirmationCall({ toolCall, status })
      : toolCall;
  });
}

function resolveTracePartToolConfirmations(
  traceParts: TracePartRecord[],
  confirmationIds: string[] | undefined,
  toolApprovalResume?: ToolApprovalResume | null,
) {
  if (!confirmationIds?.length) {
    return traceParts;
  }
  return traceParts.map((part) => {
    if (part.kind !== "tool") {
      return part;
    }
    const confirmationId = getToolConfirmationId(part.output);
    if (!confirmationId) {
      return part;
    }
    const status = getResolvedToolConfirmationStatus({
      confirmationId,
      confirmationIds,
      toolApprovalResume,
    });
    return status ? resolveTracePartToolConfirmation({ part, status }) : part;
  });
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
  const placement =
    record.placement === "inline" || record.placement === "terminal"
      ? record.placement
      : undefined;

  if (record.type === "text") {
    const text = toNullableString(record.text);
    return text && text.length > 0
      ? {
          id,
          ...(placement ? { placement } : {}),
          type: "text",
          text,
        }
      : null;
  }

  if (record.type === "reasoning") {
    const text = toNullableString(record.text);
    const durationMs = toNullableNumber(record.durationMs);
    return text && text.length > 0
      ? {
          id,
          ...(placement ? { placement } : {}),
          type: "reasoning",
          text,
          ...(durationMs !== null ? { durationMs } : {}),
        }
      : null;
  }

  if (record.type === "artifact") {
    const toolCallId = toNullableString(record.toolCallId);
    return toolCallId
      ? {
          id,
          ...(placement ? { placement } : {}),
          type: "artifact",
          toolCallId,
        }
      : null;
  }

  if (record.type === "tool") {
    const toolCallId = toNullableString(record.toolCallId);
    return toolCallId
      ? {
          id,
          ...(placement ? { placement } : {}),
          type: "tool",
          toolCallId,
        }
      : null;
  }

  return null;
}

function resolveRenderBlocksFromMetadata(
  metadata: Record<string, unknown>,
  _options: { content?: string } = {},
) {
  void _options;
  if (!Array.isArray(metadata.renderBlocks)) {
    return [] as MessageRenderBlock[];
  }

  return metadata.renderBlocks
    .map((item) => normalizeMessageRenderBlock(item))
    .filter((item): item is MessageRenderBlock => item !== null);
}

function hasRenderBlocksMetadata(metadata: Record<string, unknown>) {
  return Array.isArray(metadata.renderBlocks);
}

export {
  appendReasoningChunk,
  basename,
  createActiveThreadRunPlaceholder,
  createDurableRunKey,
  dropStaleActiveThreadRunMessages,
  excludeResolvedToolConfirmationCalls,
  findActiveThreadRunMessage,
  findLatestActiveThreadRunMessage,
  formatBytes,
  getDisplayErrorMessage,
  hasRenderBlocksMetadata,
  isCompletedArtifactToolCall,
  isCompletedWorkfileWriteToolCall,
  mapThreadMessagesToChatMessages,
  mergeThinkingStepRecords,
  normalizeCitationRecords,
  normalizeModelReasoningSegmentRecord,
  normalizeThinkingStepRecord,
  normalizeThreadCommandRequest,
  normalizeToolCallRecord,
  resolveCitationMetadata,
  resolveModelReasoningFromMetadata,
  resolveModelReasoningSegmentsFromMetadata,
  resolveReasoningTraceEventsFromMetadata,
  resolveTracePartToolConfirmations,
  resolveTracePartsFromMetadata,
  resolveRenderBlocksFromMetadata,
  resolveThinkingStepsFromMetadata,
  resolveToolConfirmationCalls,
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
  toNullableNumber,
  toNullableString,
  toObjectRecord,
  waitForThreadMessagesRetry,
  workfilePurposeLabel,
};
export type { ThreadMessageItem, WorkfileDetail };
