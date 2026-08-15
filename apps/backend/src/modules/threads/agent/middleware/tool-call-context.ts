import { AsyncLocalStorage } from "node:async_hooks";
import { createMiddleware } from "langchain";

type SourceWeftToolCallContext = {
  toolCallId: string | null;
};

const toolCallContext = new AsyncLocalStorage<SourceWeftToolCallContext>();

export function currentSourceWeftToolCallId() {
  return toolCallContext.getStore()?.toolCallId ?? null;
}

/**
 * Bridges LangChain's per-call tool id into Deep Agents' preconstructed
 * sandbox backend. Backend V2 intentionally has no ToolRuntime argument, so
 * AsyncLocalStorage preserves call identity without returning to the deprecated
 * backend-factory pattern or sharing a mutable scalar across concurrent calls.
 */
export function createSourceWeftToolCallContextMiddleware() {
  return createMiddleware({
    name: "SourceWeftToolCallContext",
    wrapToolCall: (request, handler) =>
      toolCallContext.run(
        {
          toolCallId:
            typeof request.toolCall.id === "string"
              ? request.toolCall.id
              : null,
        },
        () => handler(request),
      ),
  });
}
