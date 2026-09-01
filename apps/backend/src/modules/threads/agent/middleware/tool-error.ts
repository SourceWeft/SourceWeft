import type { MessageContent } from "@langchain/core/messages";
import { ToolInputParsingException } from "@langchain/core/tools";
import { toolErrorMiddleware, type ToolCallRequest } from "langchain";
import { sanitizeClientErrorMessage } from "../../../content/model-gateway-error";
import { redactErrorMessage } from "../../../mcp/security";
import {
  AGENT_TOOL_EXECUTION_TIMEOUT_CODE,
  AGENT_TOOL_TERMINATION_UNKNOWN_CODE,
  isAgentToolExecutionTimeoutReason,
  isAgentToolTerminationUnknownReason,
} from "./tool-execution-timeout";

const MAX_TOOL_ERROR_MESSAGE_LENGTH = 600;

function truncateToolErrorMessage(value: string) {
  const trimmed = value.trim();
  return trimmed.length <= MAX_TOOL_ERROR_MESSAGE_LENGTH
    ? trimmed
    : `${trimmed.slice(0, MAX_TOOL_ERROR_MESSAGE_LENGTH - 3).trimEnd()}...`;
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

function findCause(error: unknown, matches: (candidate: unknown) => boolean) {
  const visited = new Set<unknown>();
  let current = error;
  while (current && !visited.has(current)) {
    if (matches(current)) return current;
    visited.add(current);
    current =
      typeof current === "object" && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return undefined;
}

function isSandboxTerminationUnknownReason(value: unknown) {
  return (
    value !== null &&
    typeof value === "object" &&
    "code" in value &&
    (value as { code?: unknown }).code === "SANDBOX_TERMINATION_UNKNOWN"
  );
}

/**
 * Safe model-facing content for a failed tool call. Returning undefined keeps
 * run cancellation on LangGraph's control-flow path instead of turning it into
 * an error ToolMessage that would let the graph continue.
 */
export function formatSourceWeftToolError(
  error: unknown,
  request: ToolCallRequest,
): MessageContent | undefined {
  const agentTerminationUnknown = findCause(
    error,
    isAgentToolTerminationUnknownReason,
  );
  const sandboxTerminationUnknown = findCause(
    error,
    isSandboxTerminationUnknownReason,
  );
  const terminationUnknown =
    agentTerminationUnknown ?? sandboxTerminationUnknown;
  if (terminationUnknown) {
    const timeoutCause = findCause(
      terminationUnknown,
      isAgentToolExecutionTimeoutReason,
    );
    // A run cancellation remains LangGraph control flow. Only a timeout-owned
    // abort becomes a model-facing termination-unknown ToolMessage.
    if (request.runtime.signal?.aborted && !timeoutCause) {
      return undefined;
    }
    if (isAgentToolTerminationUnknownReason(terminationUnknown)) {
      return `[${AGENT_TOOL_TERMINATION_UNKNOWN_CODE}] Tool '${terminationUnknown.toolName}' did not confirm termination within ${terminationUnknown.terminationGraceMs}ms. Do not treat this call as successful or reuse its execution environment.`;
    }
    return `[${AGENT_TOOL_TERMINATION_UNKNOWN_CODE}] Tool '${request.toolCall.name}' could not confirm remote termination. Do not treat this call as successful or reuse its execution environment.`;
  }

  const timeout = findCause(error, isAgentToolExecutionTimeoutReason);
  if (timeout) {
    const reason = timeout as { timeoutMs: number; toolName: string };
    return `[${AGENT_TOOL_EXECUTION_TIMEOUT_CODE}] Tool '${reason.toolName}' timed out after ${reason.timeoutMs}ms. The call did not produce a successful result.`;
  }

  if (request.runtime.signal?.aborted) {
    return undefined;
  }

  const toolName = request.toolCall.name;
  if (error instanceof ToolInputParsingException) {
    return `Tool '${toolName}' rejected the generated arguments. Review its schema, correct the call, and retry.`;
  }

  const sanitized = sanitizeClientErrorMessage(errorMessage(error));
  const redacted = toolName.startsWith("mcp__")
    ? redactErrorMessage(sanitized)
    : sanitized;
  return truncateToolErrorMessage(
    redacted || `Tool '${toolName}' failed without an error message.`,
  );
}

/** Convert tool-layer exceptions into error ToolMessages the model can handle. */
export function createSourceWeftToolErrorMiddleware() {
  return toolErrorMiddleware({ onError: formatSourceWeftToolError });
}
