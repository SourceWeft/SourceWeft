import {
  isPendingToolConfirmation,
  toolConfirmationRequestSchema,
  type ToolConfirmationRequest,
  type ToolApprovalResume,
} from "@sourceweft/contracts";
import type {
  AssistantVersionIndexEntry,
  ToolConfirmationInterventionSignal,
  MessageVersion,
  ToolCallRecord,
  ToolConfirmationResolution,
} from "./types";

type ToolConfirmationItem = {
  confirmation: ToolConfirmationRequest;
  assistantMessageId: string;
  messageId: string;
  threadRunId: string | null;
  toolCall: ToolCallRecord;
};

type ActiveToolConfirmationRun = {
  assistantMessageId?: string | null;
  id?: string;
  idempotencyKey?: string;
  status?: string;
};

function getObjectRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getStringRecordValue(
  record: Record<string, unknown> | null,
  key: string,
) {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function getErrorCode(error: unknown) {
  const record = getObjectRecord(error);
  return getStringRecordValue(record, "code");
}

export function isExpiredToolConfirmationResponse(error: unknown) {
  return getErrorCode(error) === "TOOL_APPROVAL_EXPIRED";
}

export function isStaleToolConfirmationResponse(error: unknown) {
  return (
    getErrorCode(error) === "CHAT_RUN_NOT_WAITING_FOR_APPROVAL" ||
    getErrorCode(error) === "CONFIRMATION_NOT_ACTIVE"
  );
}

function getThreadRunId(version: { threadRun?: unknown }) {
  return getStringRecordValue(getObjectRecord(version.threadRun), "id");
}

function isCancelledMessageVersion(version: {
  errorCode?: string | null;
  isCancelled?: boolean;
  threadRun?: unknown;
}) {
  return (
    version.isCancelled === true ||
    version.errorCode === "CLIENT_CANCELLED" ||
    getStringRecordValue(getObjectRecord(version.threadRun), "status") ===
      "cancelled"
  );
}

function parseJsonOutput(output: unknown): unknown {
  if (typeof output !== "string") {
    const record = getObjectRecord(output);
    const content = getStringRecordValue(record, "content");
    return content ? parseJsonOutput(content) : output;
  }
  const trimmed = output.trim();
  if (!trimmed.startsWith("{")) {
    return output;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return output;
  }
}

export function getToolConfirmationOutput(
  output: unknown,
): ToolConfirmationRequest | null {
  const parsed = parseJsonOutput(output);
  const record = getObjectRecord(parsed);
  if (!record) {
    return null;
  }
  if (record.type !== "tool_confirmation_request") {
    return null;
  }
  const parsedConfirmation = toolConfirmationRequestSchema.safeParse(record);
  return parsedConfirmation.success ? parsedConfirmation.data : null;
}

function getPendingConfirmationItemsForVersion(
  version: MessageVersion,
): ToolConfirmationItem[] {
  if (isCancelledMessageVersion(version)) {
    return [];
  }

  return (version.toolCalls ?? [])
    .map((toolCall) => {
      const confirmation = getToolConfirmationOutput(toolCall.output);
      return confirmation && isPendingToolConfirmation(confirmation)
        ? {
            confirmation,
            assistantMessageId: version.id,
            messageId: version.id,
            threadRunId: getThreadRunId(version),
            toolCall,
          }
        : null;
    })
    .filter((item): item is ToolConfirmationItem => item !== null);
}

export type RunScopedToolConfirmationLookupResult =
  | {
      items: ToolConfirmationItem[];
      reason: "found" | "not_waiting";
    }
  | {
      items: [];
      reason: "missing_assistant_message";
    }
  | {
      assistantMessageId: string;
      items: [];
      reason: "assistant_message_not_found";
    };

export function getToolConfirmationItemsForRun(input: {
  activeThreadRun: ActiveToolConfirmationRun | null | undefined;
  assistantVersionById: ReadonlyMap<string, AssistantVersionIndexEntry>;
}): RunScopedToolConfirmationLookupResult {
  if (input.activeThreadRun?.status !== "waiting_for_approval") {
    return { items: [], reason: "not_waiting" };
  }

  const assistantMessageId = input.activeThreadRun.assistantMessageId;
  if (!assistantMessageId) {
    return { items: [], reason: "missing_assistant_message" };
  }

  const entry = input.assistantVersionById.get(assistantMessageId);
  if (!entry) {
    return {
      assistantMessageId,
      items: [],
      reason: "assistant_message_not_found",
    };
  }

  return {
    items: getPendingConfirmationItemsForVersion(entry.version),
    reason: "found",
  };
}

export function getLiveToolConfirmationItemsForRun(input: {
  activeThreadRun: ActiveToolConfirmationRun | null | undefined;
  signal: ToolConfirmationInterventionSignal | null | undefined;
}): ToolConfirmationItem[] {
  if (input.activeThreadRun?.status !== "waiting_for_approval") {
    return [];
  }
  const liveConfirmations = input.signal?.liveConfirmations ?? [];
  if (liveConfirmations.length === 0) {
    return [];
  }
  const signalMatchesRun =
    !input.signal?.runKey ||
    input.signal.runKey === input.activeThreadRun.idempotencyKey ||
    input.signal.threadRunId === input.activeThreadRun.id;
  if (!signalMatchesRun) {
    return [];
  }
  const assistantMessageId =
    input.signal?.assistantMessageId ?? input.activeThreadRun.assistantMessageId;
  if (!assistantMessageId) {
    return [];
  }

  return liveConfirmations
    .filter((item) => isPendingToolConfirmation(item.confirmation))
    .map((item) => ({
      assistantMessageId,
      confirmation: item.confirmation,
      messageId: assistantMessageId,
      threadRunId: input.signal?.threadRunId ?? input.activeThreadRun?.id ?? null,
      toolCall: item.toolCall,
    }));
}

function uniqueConnectorActions(
  actions: NonNullable<
    NonNullable<ToolApprovalResume["sourceweft"]>["connectorActions"]
  >,
) {
  return actions.filter((action, index) => {
    return (
      actions.findIndex(
        (candidate) =>
          candidate.toolName === action.toolName &&
          candidate.connectorId === action.connectorId &&
          candidate.actionRunId === action.actionRunId,
      ) === index
    );
  });
}

export function combineToolApprovalResumes(
  resolutions: ToolConfirmationResolution[],
): ToolApprovalResume | null {
  const activeResolutions = resolutions.filter(
    (resolution) =>
      !resolution.expired && !resolution.stale && !resolution.stopped,
  );
  if (activeResolutions.length === 0) {
    return null;
  }
  if (activeResolutions.some((resolution) => !resolution.resume)) {
    return null;
  }
  const resumes = activeResolutions
    .map((resolution) => resolution.resume)
    .filter((resume): resume is ToolApprovalResume => Boolean(resume));

  const decisions = resumes.flatMap((resume) => resume.decisions);
  if (decisions.length === 0) {
    return null;
  }

  const connectorActions = uniqueConnectorActions(
    resumes.flatMap((resume) => resume.sourceweft?.connectorActions ?? []),
  );
  const hitlInterruptId = resumes.find(
    (resume) => resume.sourceweft?.hitlInterruptId,
  )?.sourceweft?.hitlInterruptId;

  return {
    decisions,
    ...(connectorActions.length > 0 || hitlInterruptId
      ? {
          sourceweft: {
            ...(hitlInterruptId ? { hitlInterruptId } : {}),
            ...(connectorActions.length > 0 ? { connectorActions } : {}),
          },
        }
      : {}),
  };
}

export function orderToolConfirmationResolutions(input: {
  confirmationIds: string[];
  resolutions: ToolConfirmationResolution[];
}) {
  const resolutionById = new Map(
    input.resolutions.map((resolution) => [
      resolution.confirmationId,
      resolution,
    ]),
  );
  const seen = new Set<string>();
  const ordered: ToolConfirmationResolution[] = [];

  for (const confirmationId of input.confirmationIds) {
    const resolution = resolutionById.get(confirmationId);
    if (!resolution || seen.has(confirmationId)) {
      continue;
    }
    ordered.push(resolution);
    seen.add(confirmationId);
  }

  for (const resolution of input.resolutions) {
    if (seen.has(resolution.confirmationId)) {
      continue;
    }
    ordered.push(resolution);
    seen.add(resolution.confirmationId);
  }

  return ordered;
}

export function updateToolConfirmationOrder(
  previousConfirmationIds: string[],
  items: ToolConfirmationItem[],
) {
  const next = [...previousConfirmationIds];
  for (const item of items) {
    if (!next.includes(item.confirmation.id)) {
      next.push(item.confirmation.id);
    }
  }
  return next;
}

export function getPendingToolConfirmationItems(
  items: ToolConfirmationItem[],
  resolutions: ToolConfirmationResolution[],
) {
  const resolvedIds = new Set(
    resolutions.map((resolution) => resolution.confirmationId),
  );
  return items.filter(
    (item) =>
      isPendingToolConfirmation(item.confirmation) &&
      !resolvedIds.has(item.confirmation.id),
  );
}

export function getVisibleToolConfirmationItems(
  items: ToolConfirmationItem[],
  resolutions: ToolConfirmationResolution[],
) {
  return getPendingToolConfirmationItems(items, resolutions);
}

export function shouldLockComposerForApproval(input: {
  isWaitingForApproval: boolean;
  pendingConfirmationCount: number;
}) {
  return input.isWaitingForApproval && input.pendingConfirmationCount > 0;
}

export function shouldLockComposerForRun(input: {
  chatExecutionState?: "idle" | "executing" | "waiting_for_approval" | "stopping";
  isStreaming: boolean;
  isWaitingForApproval: boolean;
  pendingConfirmationCount: number;
}) {
  if (input.chatExecutionState) {
    return input.chatExecutionState !== "idle";
  }
  if (
    input.isStreaming &&
    !(input.isWaitingForApproval && input.pendingConfirmationCount === 0)
  ) {
    return true;
  }
  return shouldLockComposerForApproval(input);
}

export function isToolCallActivelyRunning(input: {
  resolvedConfirmationIds?: Set<string>;
  toolCall: Pick<ToolCallRecord, "output" | "status">;
}) {
  if (input.toolCall.status === "running") {
    return true;
  }

  if (input.toolCall.status !== "approval_requested") {
    return false;
  }

  const confirmation = getToolConfirmationOutput(input.toolCall.output);
  return (
    confirmation !== null &&
    isPendingToolConfirmation(confirmation) &&
    !(input.resolvedConfirmationIds ?? new Set<string>()).has(confirmation.id)
  );
}

export type {
  ToolConfirmationItem,
  ToolConfirmationRequest as ToolConfirmationRequestOutput,
};
