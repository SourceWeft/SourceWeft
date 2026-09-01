import { AsyncLocalStorage } from "node:async_hooks";
import { createMiddleware } from "langchain";

type SourceWeftToolCallContext = {
  producer: {
    kind: "main" | "subagent";
    subagentType?: string;
  };
  toolCallId: string | null;
  toolName: string;
};

const toolCallContext = new AsyncLocalStorage<SourceWeftToolCallContext>();
const toolInvocationSignalContext = new AsyncLocalStorage<AbortSignal>();

export function currentSourceWeftToolCallId() {
  return toolCallContext.getStore()?.toolCallId ?? null;
}

export function currentSourceWeftToolCallContext() {
  return toolCallContext.getStore() ?? null;
}

/**
 * Deep Agents' BackendProtocolV2 methods do not receive ToolRuntime. Keep the
 * host-owned invocation signal in a backend-local async context so a
 * preconstructed backend can still observe the exact Stop/deadline signal for
 * the tool call that reached it.
 */
export function currentSourceWeftToolInvocationSignal() {
  return toolInvocationSignalContext.getStore();
}

export function runWithSourceWeftToolInvocationSignal<T>(
  signal: AbortSignal,
  callback: () => T,
) {
  return toolInvocationSignalContext.run(signal, callback);
}

/**
 * Bridges LangChain's per-call tool id into Deep Agents' preconstructed
 * sandbox backend. Backend V2 intentionally has no ToolRuntime argument, so
 * AsyncLocalStorage preserves call identity without returning to the deprecated
 * backend-factory pattern or sharing a mutable scalar across concurrent calls.
 */
export function createSourceWeftToolCallContextMiddleware(input?: {
  subagentType?: string | null;
}) {
  return createMiddleware({
    name: "SourceWeftToolCallContext",
    wrapToolCall: (request, handler) =>
      toolCallContext.run(
        {
          producer: input?.subagentType
            ? { kind: "subagent", subagentType: input.subagentType }
            : { kind: "main" },
          toolCallId:
            typeof request.toolCall.id === "string"
              ? request.toolCall.id
              : null,
          toolName: request.toolCall.name,
        },
        () => handler(request),
      ),
  });
}
