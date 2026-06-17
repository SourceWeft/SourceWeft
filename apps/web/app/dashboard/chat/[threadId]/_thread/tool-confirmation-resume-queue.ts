import {
  SOURCEWEFT_WEB_RUN_IDEMPOTENCY_PREFIX,
  type ToolApprovalResume,
} from "@sourceweft/sdk";
import type { ThreadStreamActionInput } from "./use-thread-stream-action";

export type ToolConfirmationResumeRequest = {
  approvalThreadRunId: string | null;
  assistantMessageId: string;
  resolvedConfirmationIds: string[];
  toolApprovalResume: ToolApprovalResume;
};

export type ToolConfirmationResumeQueueState = {
  pending: ToolConfirmationResumeRequest | null;
};

export function createToolConfirmationResumeQueueState(): ToolConfirmationResumeQueueState {
  return {
    pending: null,
  };
}

function normalizeForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeForStableJson);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const normalizedValue = normalizeForStableJson(record[key]);
    if (normalizedValue !== undefined) {
      normalized[key] = normalizedValue;
    }
  }
  return normalized;
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalizeForStableJson(value)) ?? "undefined";
}

export function getToolConfirmationResumeRequestKey(
  request: ToolConfirmationResumeRequest,
) {
  return stableJson({
    approvalThreadRunId: request.approvalThreadRunId,
    assistantMessageId: request.assistantMessageId,
    resolvedConfirmationIds: request.resolvedConfirmationIds,
    toolApprovalResume: request.toolApprovalResume,
  });
}

function hashString(value: string) {
  let first = 0xdeadbeef;
  let second = 0x41c6ce57;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 2654435761);
    second = Math.imul(second ^ code, 1597334677);
  }
  first = Math.imul(first ^ (first >>> 16), 2246822507);
  first ^= Math.imul(second ^ (second >>> 13), 3266489909);
  second = Math.imul(second ^ (second >>> 16), 2246822507);
  second ^= Math.imul(first ^ (first >>> 13), 3266489909);
  return `${(second >>> 0).toString(36)}${(first >>> 0).toString(36)}`;
}

function keySegment(value: string, maxLength: number) {
  const segment = value
    .replace(/[^a-zA-Z0-9._:-]+/g, "_")
    .slice(0, maxLength);
  return segment || "unknown";
}

export function getToolConfirmationResumeDurableRunKey(
  request: ToolConfirmationResumeRequest,
) {
  const requestKey = getToolConfirmationResumeRequestKey(request);
  const runSegment = keySegment(request.approvalThreadRunId ?? "run:none", 48);
  const assistantSegment = keySegment(request.assistantMessageId, 48);
  const confirmationSegment =
    request.resolvedConfirmationIds
      .map((confirmationId) => keySegment(confirmationId, 32))
      .join(".")
      .slice(0, 96) || "none";
  return `${SOURCEWEFT_WEB_RUN_IDEMPOTENCY_PREFIX}resume:${runSegment}:${assistantSegment}:${confirmationSegment}:${hashString(
    requestKey,
  )}`;
}

export function resolveToolConfirmationResumeRequest(input: {
  isStreaming: boolean;
  request: ToolConfirmationResumeRequest;
  state: ToolConfirmationResumeQueueState;
}) {
  if (input.isStreaming) {
    return {
      runnable: null,
      state: {
        ...input.state,
        pending: input.request,
      },
    };
  }

  return {
    runnable: input.request,
    state: {
      pending: null,
    },
  };
}

export function flushPendingToolConfirmationResume(input: {
  isStreaming: boolean;
  state: ToolConfirmationResumeQueueState;
}) {
  if (input.isStreaming || !input.state.pending) {
    return {
      runnable: null,
      state: input.state,
    };
  }

  const pending = input.state.pending;

  return {
    runnable: pending,
    state: {
      pending: null,
    },
  };
}

export function buildToolConfirmationResumeStreamInput(
  input: ToolConfirmationResumeRequest,
): ThreadStreamActionInput {
  return {
    mode: "resume",
    assistantMessageId: input.assistantMessageId,
    attachOnly: true,
    durableRunKey: getToolConfirmationResumeDurableRunKey(input),
    resolvedConfirmationIds: input.resolvedConfirmationIds,
    toolApprovalResume: input.toolApprovalResume,
  };
}
