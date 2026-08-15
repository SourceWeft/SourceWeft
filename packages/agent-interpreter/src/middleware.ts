import { randomUUID } from "node:crypto";
import { ToolMessage } from "@langchain/core/messages";
import { createCodeInterpreterMiddleware } from "@langchain/quickjs";
import { createMiddleware, type AgentMiddleware } from "langchain";
import {
  classifyRuntimeOutput,
  InterpreterError,
  interpreterErrorCode,
  normalizeRuntimeError,
  safeInterpreterErrorText,
} from "./errors";
import { createInterpreterReadTools } from "./read-tools";
import type {
  InterpreterEvent,
  InterpreterErrorCode,
  SourceWeftInterpreterOptions,
} from "./types";

const SYSTEM_PROMPT = `
An eval tool is available for bounded JavaScript/TypeScript data processing in
an isolated QuickJS WASM runtime. It has no network, shell, module loading, host
filesystem, or subagent access. Only the listed read-only tools are bridged via
the tools namespace. They can access /kb and /workfiles only. Never attempt to
write files or bypass these boundaries. Keep code and returned values concise.
`;

function emitSafely(
  sink: SourceWeftInterpreterOptions["eventSink"],
  event: InterpreterEvent,
) {
  if (!sink) return Promise.resolve();
  return Promise.resolve(sink(event)).catch(() => undefined);
}

function codeFromToolCall(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" ? code : "";
}

function resultText(value: unknown) {
  if (!ToolMessage.isInstance(value)) return "";
  return typeof value.content === "string"
    ? value.content
    : JSON.stringify(value.content);
}

function replaceToolMessage(value: unknown, content: string) {
  if (!ToolMessage.isInstance(value)) return value;
  return new ToolMessage({
    content,
    tool_call_id: value.tool_call_id,
    status: value.status,
    name: value.name,
    id: value.id,
    additional_kwargs: value.additional_kwargs,
    response_metadata: value.response_metadata,
    metadata: value.metadata,
  });
}

function truncate(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  const marker = `\n[truncated ${value.length - maxChars} chars]`;
  if (marker.length >= maxChars) return marker.slice(0, maxChars);
  return `${value.slice(0, Math.max(0, maxChars - marker.length))}${marker}`;
}

function stableRuntimeResult(
  value: string,
  errorCode: InterpreterErrorCode | undefined,
  maxChars: number,
) {
  if (errorCode) return safeInterpreterErrorText(errorCode);
  return truncate(value, maxChars);
}

export function createSourceWeftInterpreterMiddleware(
  options: SourceWeftInterpreterOptions,
): AgentMiddleware[] {
  for (const [name, value] of Object.entries(options.limits)) {
    if (options.gate.limits[name as keyof typeof options.limits] !== value) {
      throw new Error(
        `Interpreter gate limit '${name}' does not match middleware limits.`,
      );
    }
  }
  const ptcTools = createInterpreterReadTools(options);
  const interpreter = createCodeInterpreterMiddleware({
    ptc: ptcTools,
    memoryLimitBytes: options.limits.memoryLimitBytes,
    maxStackSizeBytes: options.limits.maxStackSizeBytes,
    executionTimeoutMs: options.limits.executionTimeoutMs,
    maxPtcCalls: options.limits.maxPtcCallsPerEval,
    maxResultChars: options.limits.maxResultChars,
    systemPrompt: SYSTEM_PROMPT,
    subagents: false,
    toolName: "eval",
  });

  const guard = createMiddleware({
    name: "SourceWeftInterpreterGuard",
    wrapToolCall: async (request, handler) => {
      if (request.toolCall.name !== "eval") {
        return handler(request);
      }

      const operationId = randomUUID();
      const code = codeFromToolCall(request.toolCall.args);
      if (code.length > options.limits.maxCodeChars) {
        const error = new InterpreterError(
          "EVAL_LIMIT",
          "Interpreter code exceeds the per-evaluation size limit.",
        );
        await emitSafely(options.eventSink, {
          codeChars: code.length,
          context: options.context,
          errorCode: error.code,
          kind: "eval",
          operationId,
          phase: "rejected",
          toolName: "eval",
        });
        throw error;
      }

      let release: (() => void) | undefined;
      try {
        release = await options.gate.acquireEval(options.context.turnId);
      } catch (error) {
        await emitSafely(options.eventSink, {
          codeChars: code.length,
          context: options.context,
          errorCode: interpreterErrorCode(error),
          kind: "eval",
          operationId,
          phase: "rejected",
          toolName: "eval",
        });
        throw error;
      }

      const startedAt = Date.now();
      await emitSafely(options.eventSink, {
        codeChars: code.length,
        context: options.context,
        kind: "eval",
        operationId,
        phase: "started",
        toolName: "eval",
      });
      try {
        const result = await handler(request);
        const rawText = resultText(result);
        const errorCode = classifyRuntimeOutput(rawText);
        const safeText = stableRuntimeResult(
          rawText,
          errorCode,
          options.limits.maxResultChars,
        );
        await emitSafely(options.eventSink, {
          codeChars: code.length,
          context: options.context,
          durationMs: Date.now() - startedAt,
          errorCode,
          kind: "eval",
          operationId,
          phase: errorCode ? "rejected" : "completed",
          resultChars: safeText.length,
          toolName: "eval",
        });
        return replaceToolMessage(result, safeText) as typeof result;
      } catch (error) {
        const normalized = normalizeRuntimeError(error);
        await emitSafely(options.eventSink, {
          codeChars: code.length,
          context: options.context,
          durationMs: Date.now() - startedAt,
          errorCode: interpreterErrorCode(normalized),
          kind: "eval",
          operationId,
          phase: "rejected",
          toolName: "eval",
        });
        throw normalized;
      } finally {
        release();
      }
    },
    afterAgent: () => {
      options.gate.resetTurn(options.context.turnId);
    },
  });

  return [interpreter, guard];
}
