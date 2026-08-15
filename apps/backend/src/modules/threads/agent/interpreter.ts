import type { StructuredToolInterface } from "@langchain/core/tools";
import {
  createInterpreterExecutionGate,
  createSourceWeftInterpreterMiddleware,
  type InterpreterEvent,
  type InterpreterEventContext,
  type InterpreterReadToolName,
} from "@sourceweft/agent-interpreter";
import type { AnyBackendProtocol } from "deepagents";
import { config } from "../../../shared/config";
import { logger } from "../../../shared/logger";
import { metrics } from "../../../shared/metrics";
import { endSpan, startSpan, type TraceContext } from "../../llm-observability";

const executionGate = createInterpreterExecutionGate(
  config.chat.agent.interpreter.limits,
);

function eventLogMetadata(event: InterpreterEvent) {
  return {
    kind: event.kind,
    phase: event.phase,
    operationId: event.operationId,
    toolName: event.toolName,
    durationMs: event.durationMs,
    codeChars: event.codeChars,
    resultChars: event.resultChars,
    errorCode: event.errorCode,
    runId: event.context.runId,
    teamId: event.context.teamId,
    workspaceId: event.context.workspaceId,
    threadId: event.context.threadId,
    turnId: event.context.turnId,
    userId: event.context.userId,
  };
}

function createEventSink(traceContext?: TraceContext) {
  return async (event: InterpreterEvent) => {
    const status = event.phase === "rejected" ? "error" : event.phase;
    metrics.inc("agent.interpreter.events", {
      kind: event.kind,
      phase: event.phase,
      status,
      tool: event.toolName,
      ...(event.errorCode ? { error_code: event.errorCode } : {}),
    });
    if (event.durationMs !== undefined) {
      metrics.observe("agent.interpreter.duration_ms", event.durationMs, {
        kind: event.kind,
        status,
        tool: event.toolName,
      });
    }

    const metadata = eventLogMetadata(event);
    if (event.phase === "rejected") {
      logger.warn("agent.interpreter.event", metadata);
    } else {
      logger.info("agent.interpreter.event", metadata);
    }

    if (!traceContext || event.kind !== "ptc") return;
    if (event.phase === "started") {
      await startSpan({
        ...traceContext,
        spanId: event.operationId,
        parentSpanId: traceContext.parentSpanId,
        name: `interpreter:${event.toolName}`,
        kind: "tool",
        operation: "interpreter.ptc",
        input: { toolName: event.toolName },
        metadata: { interpreter: true, toolName: event.toolName },
      });
      return;
    }
    await endSpan({
      traceId: traceContext.traceId,
      teamId: traceContext.teamId,
      workspaceId: traceContext.workspaceId,
      spanId: event.operationId,
      status: event.phase === "rejected" ? "error" : "ok",
      latencyMs: event.durationMs,
      output:
        event.resultChars === undefined
          ? undefined
          : { resultChars: event.resultChars },
      errorCode: event.errorCode,
      errorMessage: event.errorCode,
      metadata: { interpreter: true, toolName: event.toolName },
    });
  };
}

export function createInterpreterMiddlewareForTurn(input: {
  allowedTools: readonly InterpreterReadToolName[];
  backend: AnyBackendProtocol;
  context: InterpreterEventContext;
  searchSourcesTool?: StructuredToolInterface;
  traceContext?: TraceContext;
}) {
  if (!config.chat.agent.interpreter.enabled) return [];
  return createSourceWeftInterpreterMiddleware({
    backend: input.backend,
    allowedTools: input.allowedTools,
    searchSourcesTool: input.searchSourcesTool,
    limits: config.chat.agent.interpreter.limits,
    gate: executionGate,
    eventSink: createEventSink(input.traceContext),
    context: input.context,
  });
}
