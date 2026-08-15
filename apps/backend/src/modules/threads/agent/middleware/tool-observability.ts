import { createMiddleware } from "langchain";
import { isGraphBubbleUp } from "@langchain/langgraph";
import {
  AGENT_TOOL_LOG_EVENTS,
  logAgentToolEvent,
  type AgentToolLogMetadata,
} from "../tool-logging";
import {
  endSpan,
  startSpan,
  type TraceContext,
} from "../../../llm-observability";
import { getFilesystemToolFailureMetadata } from "../turn/output-normalizer";

export type SourceWeftToolObservabilityContext = {
  runId?: string | null;
  subagentType?: string | null;
  teamId?: string | null;
  threadId?: string | null;
  userId?: string | null;
  userMessageId?: string | null;
  workspaceId?: string | null;
};

export type SourceWeftToolObservabilityMiddlewareInput = {
  context?: SourceWeftToolObservabilityContext;
  traceContext?: TraceContext;
};

function safeString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function toolCallArgs(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const args = (value as { args?: unknown }).args;
  return args && typeof args === "object" && !Array.isArray(args)
    ? args
    : undefined;
}

function resolveToolStatus(result: unknown): "completed" | "error" {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return "completed";
  }
  return (result as { status?: unknown }).status === "error"
    ? "error"
    : "completed";
}

function buildAgentToolLogMetadata(input: {
  context?: SourceWeftToolObservabilityContext;
  durationMs?: number | null;
  error?: unknown;
  failureMetadata?: AgentToolLogMetadata;
  status?: string;
  toolCallId?: string;
  toolName: string;
}): AgentToolLogMetadata {
  return {
    toolName: input.toolName,
    toolCallId: input.toolCallId,
    threadId: input.context?.threadId,
    userMessageId: input.context?.userMessageId,
    workspaceId: input.context?.workspaceId,
    teamId: input.context?.teamId,
    userId: input.context?.userId,
    runId: input.context?.runId,
    subagentType: input.context?.subagentType,
    ...input.failureMetadata,
    durationMs: input.durationMs ?? undefined,
    error: input.error,
    status: input.status,
  };
}

export function createSourceWeftToolObservabilityMiddleware(
  input: SourceWeftToolObservabilityMiddlewareInput = {},
) {
  return createMiddleware({
    name: "SourceWeftToolObservability",
    wrapToolCall: async (request, handler) => {
      const toolName = request.toolCall.name;
      const toolCallId = safeString(request.toolCall.id);
      const startedAt = Date.now();
      const toolInput = toolCallArgs(request.toolCall);

      logAgentToolEvent(
        "info",
        AGENT_TOOL_LOG_EVENTS.started,
        buildAgentToolLogMetadata({
          context: input.context,
          status: "running",
          toolCallId,
          toolName,
        }),
      );

      if (input.traceContext && toolCallId) {
        await startSpan({
          ...input.traceContext,
          spanId: toolCallId,
          parentSpanId: input.traceContext.parentSpanId,
          name: `tool:${toolName}`,
          kind: "tool",
          operation: "tool.call",
          input: toolInput,
          metadata: {
            toolName,
            subagent_type: input.context?.subagentType,
          },
        });
      }

      try {
        const result = await handler(request);
        const latencyMs = Date.now() - startedAt;
        const status = resolveToolStatus(result);
        const error =
          status === "error" && result && typeof result === "object"
            ? (result as { content?: unknown }).content
            : undefined;
        const failureMetadata =
          status === "error"
            ? getFilesystemToolFailureMetadata(toolName, result)
            : {};

        logAgentToolEvent(
          status === "error" ? "error" : "info",
          status === "error"
            ? AGENT_TOOL_LOG_EVENTS.failed
            : AGENT_TOOL_LOG_EVENTS.completed,
          buildAgentToolLogMetadata({
            context: input.context,
            durationMs: latencyMs,
            error,
            failureMetadata,
            status,
            toolCallId,
            toolName,
          }),
        );

        if (input.traceContext && toolCallId) {
          await endSpan({
            traceId: input.traceContext.traceId,
            teamId: input.traceContext.teamId,
            workspaceId: input.traceContext.workspaceId,
            spanId: toolCallId,
            status: status === "error" ? "error" : "ok",
            latencyMs,
            output: result,
            ...(status === "error" && error
              ? { errorMessage: String(error) }
              : {}),
            metadata: {
              toolName,
              subagent_type: input.context?.subagentType,
            },
          });
        }

        return result;
      } catch (error) {
        // A LangGraph interrupt (e.g. `askUser` calling `interrupt()`, or a HITL
        // approval gate) is a control-flow pause, not a tool failure. Re-raise
        // it untouched so it is neither logged as `failed` nor closed as an
        // error span — otherwise every pause is mis-recorded as a crash.
        if (isGraphBubbleUp(error)) {
          throw error;
        }
        const latencyMs = Date.now() - startedAt;
        logAgentToolEvent(
          "error",
          AGENT_TOOL_LOG_EVENTS.failed,
          buildAgentToolLogMetadata({
            context: input.context,
            durationMs: latencyMs,
            error,
            status: "error",
            toolCallId,
            toolName,
          }),
        );

        if (input.traceContext && toolCallId) {
          await endSpan({
            traceId: input.traceContext.traceId,
            teamId: input.traceContext.teamId,
            workspaceId: input.traceContext.workspaceId,
            spanId: toolCallId,
            status: "error",
            latencyMs,
            errorMessage:
              error instanceof Error ? error.message : String(error),
            metadata: {
              toolName,
              subagent_type: input.context?.subagentType,
            },
          });
        }

        throw error;
      }
    },
  });
}
