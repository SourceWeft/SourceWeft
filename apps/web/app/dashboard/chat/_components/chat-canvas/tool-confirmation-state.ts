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
  VersionedMessageGroup,
  ArtifactStatusSnapshot,
} from "./types";
import {
  isArtifactSnapshotActive,
  isToolOutputClaimingInProgress,
  resolveMessageToolCalls,
  resolveToolCallArtifactId,
} from "./artifact-work-state";
import {
  isDeliverableGenerationActive,
  isDeliverableToolName,
} from "./artifact-progress";

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

function isExpiredApprovalMessageVersion(version: {
  errorCode?: string | null;
}) {
  return version.errorCode === "TOOL_APPROVAL_EXPIRED";
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

export function hasLiveToolConfirmationSignalForRun(input: {
  activeThreadRun: ActiveToolConfirmationRun | null | undefined;
  signal: ToolConfirmationInterventionSignal | null | undefined;
}) {
  if (input.activeThreadRun?.status !== "waiting_for_approval") {
    return false;
  }
  const signal = input.signal;
  if (!signal) {
    return false;
  }
  if ((signal.liveConfirmations ?? []).length === 0) {
    return false;
  }
  return (
    signal.runKey === input.activeThreadRun.idempotencyKey ||
    (Boolean(signal.threadRunId) &&
      signal.threadRunId === input.activeThreadRun.id)
  );
}

export function getLiveToolConfirmationItemsForRun(input: {
  activeThreadRun: ActiveToolConfirmationRun | null | undefined;
  signal: ToolConfirmationInterventionSignal | null | undefined;
}): ToolConfirmationItem[] {
  if (input.activeThreadRun?.status !== "waiting_for_approval") {
    return [];
  }
  const signal = input.signal;
  if (!signal) {
    return [];
  }
  const liveConfirmations = signal.liveConfirmations ?? [];
  if (
    !hasLiveToolConfirmationSignalForRun({
      activeThreadRun: input.activeThreadRun,
      signal,
    })
  ) {
    return [];
  }
  const assistantMessageId =
    signal.assistantMessageId ??
    input.activeThreadRun.assistantMessageId;
  if (!assistantMessageId) {
    return [];
  }

  return liveConfirmations
    .filter((item) => isPendingToolConfirmation(item.confirmation))
    .map((item) => ({
      assistantMessageId,
      confirmation: item.confirmation,
      messageId: assistantMessageId,
      threadRunId:
        signal.threadRunId ?? input.activeThreadRun?.id ?? null,
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

function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(
        ([key, item]) => `${JSON.stringify(key)}:${stableJsonStringify(item)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function uniqueSandboxActions(
  actions: NonNullable<
    NonNullable<ToolApprovalResume["sourceweft"]>["sandboxActions"]
  >,
) {
  return actions.filter((action, index) => {
    return (
      actions.findIndex(
        (candidate) =>
          candidate.toolName === action.toolName &&
          candidate.toolCallId === action.toolCallId &&
          stableJsonStringify(candidate.requestJson) ===
            stableJsonStringify(action.requestJson),
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
  const sandboxActions = uniqueSandboxActions(
    resumes.flatMap((resume) => resume.sourceweft?.sandboxActions ?? []),
  );
  const sourceweftMetadata = resumes.reduce<
    NonNullable<ToolApprovalResume["sourceweft"]>
  >((metadata, resume) => {
    if (!resume.sourceweft) {
      return metadata;
    }
    const {
      connectorActions: _connectorActions,
      sandboxActions: _sandboxActions,
      ...rest
    } = resume.sourceweft;
    return { ...metadata, ...rest };
  }, {});
  const sourceweft =
    Object.keys(sourceweftMetadata).length > 0 ||
    connectorActions.length > 0 ||
    sandboxActions.length > 0
      ? {
          ...sourceweftMetadata,
          ...(connectorActions.length > 0 ? { connectorActions } : {}),
          ...(sandboxActions.length > 0 ? { sandboxActions } : {}),
        }
      : undefined;

  return {
    decisions,
    ...(sourceweft ? { sourceweft } : {}),
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

function getPendingConfirmationIdsForVersion(version: MessageVersion) {
  return (version.toolCalls ?? [])
    .map((toolCall) => getToolConfirmationOutput(toolCall.output))
    .filter(
      (confirmation): confirmation is ToolConfirmationRequest =>
        confirmation !== null && isPendingToolConfirmation(confirmation),
    )
    .map((confirmation) => confirmation.id);
}

function pushResolutionIfMissing(input: {
  resolutions: ToolConfirmationResolution[];
  seen: Set<string>;
  resolution: ToolConfirmationResolution;
}) {
  if (input.seen.has(input.resolution.confirmationId)) {
    return;
  }
  input.seen.add(input.resolution.confirmationId);
  input.resolutions.push(input.resolution);
}

function getSelectedUserVersionIdForAssistant(input: {
  activeVersionByGroup?: Record<string, number>;
  group: VersionedMessageGroup;
  messageGroups: VersionedMessageGroup[];
}) {
  if (input.group.role !== "assistant" || !input.group.turnId) {
    return null;
  }

  const userGroup = input.messageGroups.find(
    (candidate) =>
      candidate.role === "user" && candidate.turnId === input.group.turnId,
  );
  if (!userGroup) {
    return null;
  }

  const latestUserVersionIndex = Math.max(userGroup.versions.length - 1, 0);
  const activeUserBranchIndex = Math.min(
    Math.max(
      input.activeVersionByGroup?.[userGroup.groupId] ??
        latestUserVersionIndex,
      0,
    ),
    latestUserVersionIndex,
  );
  return userGroup.versions[activeUserBranchIndex]?.id ?? null;
}

function getSelectedMessageVersion(input: {
  activeVersionByGroup?: Record<string, number>;
  group: VersionedMessageGroup;
  messageGroups: VersionedMessageGroup[];
}) {
  const entries = input.group.versions.map((version, originalIndex) => ({
    originalIndex,
    version,
  }));
  const selectedUserVersionId = getSelectedUserVersionIdForAssistant(input);
  const scopedEntries =
    input.group.role === "assistant" && selectedUserVersionId
      ? entries.filter(
          (entry) => entry.version.sourceUserMessageId === selectedUserVersionId,
        )
      : entries;
  const visibleEntries = scopedEntries.length > 0 ? scopedEntries : entries;
  const latestVisibleIndex = Math.max(visibleEntries.length - 1, 0);
  const desiredOriginalIndex =
    input.activeVersionByGroup?.[input.group.groupId] ??
    visibleEntries[latestVisibleIndex]?.originalIndex ??
    0;
  const matchedVisibleIndex = visibleEntries.findIndex(
    (entry) => entry.originalIndex === desiredOriginalIndex,
  );
  const activeVisibleIndex =
    matchedVisibleIndex >= 0 ? matchedVisibleIndex : latestVisibleIndex;
  return visibleEntries[activeVisibleIndex]?.version ?? null;
}

export function deriveTerminalToolConfirmationResolutions(input: {
  activeVersionByGroup?: Record<string, number>;
  messageGroups: VersionedMessageGroup[];
}) {
  const resolutions: ToolConfirmationResolution[] = [];
  const seen = new Set<string>();

  for (const group of input.messageGroups) {
    if (group.role !== "assistant" || group.versions.length === 0) {
      continue;
    }

    const version = getSelectedMessageVersion({
      activeVersionByGroup: input.activeVersionByGroup,
      group,
      messageGroups: input.messageGroups,
    });
    if (!version) {
      continue;
    }

    const confirmationIds = getPendingConfirmationIdsForVersion(version);
    if (confirmationIds.length === 0) {
      continue;
    }

    if (isExpiredApprovalMessageVersion(version)) {
      for (const confirmationId of confirmationIds) {
        pushResolutionIfMissing({
          resolutions,
          seen,
          resolution: {
            confirmationId,
            decision: "reject",
            expired: true,
            resume: null,
          },
        });
      }
      continue;
    }

    if (isCancelledMessageVersion(version)) {
      for (const confirmationId of confirmationIds) {
        pushResolutionIfMissing({
          resolutions,
          seen,
          resolution: {
            confirmationId,
            decision: "reject",
            resume: null,
            stopped: true,
          },
        });
      }
    }
  }

  return resolutions;
}

export function mergeToolConfirmationResolutions(input: {
  derived: ToolConfirmationResolution[];
  local: ToolConfirmationResolution[];
}) {
  const localIds = new Set(
    input.local.map((resolution) => resolution.confirmationId),
  );
  return [
    ...input.local,
    ...input.derived.filter(
      (resolution) => !localIds.has(resolution.confirmationId),
    ),
  ];
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
  chatExecutionState?:
    | "idle"
    | "executing"
    | "waiting_for_approval"
    | "stopping";
  /** Background tool/artifact work that outlives the stream (e.g. async jobs). */
  hasActivelyRunningToolWork?: boolean;
  isStreaming: boolean;
  isWaitingForApproval: boolean;
  pendingConfirmationCount: number;
}) {
  if (input.chatExecutionState && input.chatExecutionState !== "idle") {
    return true;
  }
  if (
    input.isStreaming &&
    !(input.isWaitingForApproval && input.pendingConfirmationCount === 0)
  ) {
    return true;
  }
  if (input.hasActivelyRunningToolWork) {
    return true;
  }
  return shouldLockComposerForApproval(input);
}

export function isToolCallActivelyRunning(input: {
  artifactStatuses?: ReadonlyMap<string, ArtifactStatusSnapshot>;
  resolvedConfirmationIds?: Set<string>;
  toolCall: Pick<ToolCallRecord, "output" | "status" | "tool">;
}) {
  if (input.toolCall.status === "running") {
    return true;
  }

  if (input.toolCall.status !== "approval_requested") {
    const artifactId = resolveToolCallArtifactId(input.toolCall.output);
    if (!artifactId) {
      return false;
    }
    const artifactSnapshot = input.artifactStatuses?.get(artifactId);
    if (isDeliverableToolName(input.toolCall.tool)) {
      // Fire-and-forget deliverable rows stay "running" forever in message
      // metadata; generation/snapshot resolution is the only reliable signal.
      return isDeliverableGenerationActive({
        artifactSnapshot,
        toolCallOutput: input.toolCall.output,
        toolCallStatus: input.toolCall.status,
        toolName: input.toolCall.tool,
      });
    }
    if (artifactSnapshot) {
      return isArtifactSnapshotActive(artifactSnapshot);
    }
    return isToolOutputClaimingInProgress(input.toolCall.output);
  }

  const confirmation = getToolConfirmationOutput(input.toolCall.output);
  return (
    confirmation !== null &&
    isPendingToolConfirmation(confirmation) &&
    !(input.resolvedConfirmationIds ?? new Set<string>()).has(confirmation.id)
  );
}

export function hasActivelyRunningToolWork(input: {
  artifactStatuses?: ReadonlyMap<string, ArtifactStatusSnapshot>;
  messages: Array<{
    metadata?: Record<string, unknown>;
    toolCalls?: ToolCallRecord[];
  }>;
  resolvedConfirmationIds?: Set<string>;
}) {
  for (const message of input.messages) {
    for (const toolCall of resolveMessageToolCalls(message)) {
      if (
        isToolCallActivelyRunning({
          artifactStatuses: input.artifactStatuses,
          resolvedConfirmationIds: input.resolvedConfirmationIds,
          toolCall,
        })
      ) {
        return true;
      }
    }
  }

  if (input.artifactStatuses) {
    for (const snapshot of input.artifactStatuses.values()) {
      if (isArtifactSnapshotActive(snapshot)) {
        return true;
      }
    }
  }

  return false;
}

export type {
  ToolConfirmationItem,
  ToolConfirmationRequest as ToolConfirmationRequestOutput,
};
