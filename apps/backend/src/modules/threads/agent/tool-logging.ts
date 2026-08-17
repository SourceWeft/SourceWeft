import { logger } from "../../../shared/logger";

export const AGENT_TOOL_LOG_EVENTS = {
  started: "agent.tool.started",
  completed: "agent.tool.completed",
  failed: "agent.tool.failed",
  stageStarted: "agent.tool.stage.started",
  stageCompleted: "agent.tool.stage.completed",
  stageFailed: "agent.tool.stage.failed",
  enqueued: "agent.tool.enqueued",
  workerStarted: "agent.tool.worker.started",
  workerCompleted: "agent.tool.worker.completed",
  workerFailed: "agent.tool.worker.failed",
  workerStageStarted: "agent.tool.worker.stage.started",
  workerStageCompleted: "agent.tool.worker.stage.completed",
  workerStageFailed: "agent.tool.worker.stage.failed",
} as const;

export type AgentToolLogEvent =
  (typeof AGENT_TOOL_LOG_EVENTS)[keyof typeof AGENT_TOOL_LOG_EVENTS];

export type AgentToolLogLevel = "info" | "warn" | "error";

type SanitizedError = {
  name?: string;
  code?: string;
  category?: string;
  message?: string;
  retryable?: boolean;
};

export type AgentToolLogMetadata = {
  event?: AgentToolLogEvent;
  toolName?: unknown;
  toolCallId?: unknown;
  threadId?: unknown;
  userMessageId?: unknown;
  workspaceId?: unknown;
  teamId?: unknown;
  userId?: unknown;
  jobId?: unknown;
  artifactId?: unknown;
  requestKey?: unknown;
  stage?: unknown;
  status?: unknown;
  durationMs?: unknown;
  attempt?: unknown;
  commandFingerprint?: unknown;
  failureCode?: unknown;
  failureHint?: unknown;
  failureMessage?: unknown;
  maxAttempts?: unknown;
  repeatCount?: unknown;
  runId?: unknown;
  subagentType?: unknown;
  counts?: unknown;
  outputFormat?: unknown;
  error?: unknown;
};

const MAX_STRING_LENGTH = 240;
const GENERIC_ERROR_MESSAGE = "Tool execution failed.";

const stringFields = [
  "toolName",
  "toolCallId",
  "threadId",
  "userMessageId",
  "workspaceId",
  "teamId",
  "userId",
  "jobId",
  "artifactId",
  "commandFingerprint",
  "failureCode",
  "failureHint",
  "failureMessage",
  "requestKey",
  "runId",
  "subagentType",
  "stage",
  "status",
  "outputFormat",
] as const;

function truncateString(value: string, maxLength = MAX_STRING_LENGTH) {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
}

function sanitizeString(value: unknown) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? truncateString(trimmed) : undefined;
}

function sanitizeFiniteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function sanitizeCounts(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const counts: Record<string, number> = {};
  for (const [key, count] of Object.entries(value)) {
    if (
      /^[a-zA-Z0-9_.-]{1,64}$/.test(key) &&
      typeof count === "number" &&
      Number.isFinite(count)
    ) {
      counts[key] = count;
    }
  }
  return Object.keys(counts).length > 0 ? counts : undefined;
}

function sanitizeError(value: unknown): SanitizedError | undefined {
  if (!value) {
    return undefined;
  }

  if (typeof value === "string") {
    const message = value.trim();
    return message ? { message: GENERIC_ERROR_MESSAGE } : undefined;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    return { message: GENERIC_ERROR_MESSAGE };
  }

  const record = value as Record<string, unknown>;
  const error: SanitizedError = {};
  const name = sanitizeString(record.name);
  const code = sanitizeString(record.code);
  const category = sanitizeString(record.category);
  const retryable = record.retryable;

  if (name) {
    error.name = name;
  }
  if (code) {
    error.code = code;
  }
  if (category) {
    error.category = category;
  }
  error.message = GENERIC_ERROR_MESSAGE;
  if (typeof retryable === "boolean") {
    error.retryable = retryable;
  }

  return Object.keys(error).length > 0 ? error : undefined;
}

export function sanitizeAgentToolLogMetadata(
  event: AgentToolLogEvent,
  metadata: AgentToolLogMetadata,
) {
  const sanitized: Record<string, unknown> = { event };

  for (const field of stringFields) {
    const value = sanitizeString(metadata[field]);
    if (value !== undefined) {
      sanitized[field] = value;
    }
  }

  for (const field of [
    "durationMs",
    "attempt",
    "maxAttempts",
    "repeatCount",
  ] as const) {
    const value = sanitizeFiniteNumber(metadata[field]);
    if (value !== undefined) {
      sanitized[field] = value;
    }
  }

  const counts = sanitizeCounts(metadata.counts);
  if (counts) {
    sanitized.counts = counts;
  }

  const error = sanitizeError(metadata.error);
  if (error) {
    sanitized.error = error;
  }

  return sanitized;
}

export function logAgentToolEvent(
  level: AgentToolLogLevel,
  event: AgentToolLogEvent,
  metadata: AgentToolLogMetadata,
) {
  try {
    const sanitized = sanitizeAgentToolLogMetadata(event, metadata);
    logger[level](event, sanitized);
  } catch {
    return;
  }
}
