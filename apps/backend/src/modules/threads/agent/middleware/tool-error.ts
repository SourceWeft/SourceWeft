import type { MessageContent } from "@langchain/core/messages";
import { ToolInputParsingException } from "@langchain/core/tools";
import {
  toolErrorMiddleware,
  type ToolCallRequest,
} from "langchain";
import { sanitizeClientErrorMessage } from "../../../content/model-gateway-error";
import { redactErrorMessage } from "../../../mcp/security";

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

/**
 * Safe model-facing content for a failed tool call. Returning undefined keeps
 * run cancellation on LangGraph's control-flow path instead of turning it into
 * an error ToolMessage that would let the graph continue.
 */
export function formatSourceWeftToolError(
  error: unknown,
  request: ToolCallRequest,
): MessageContent | undefined {
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
