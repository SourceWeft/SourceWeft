import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { createMiddleware } from "langchain";

export const UNANSWERED_TOOL_CALL_RESULT =
  "This tool call was not run. Call it again if it is still needed.";

type ToolCall = NonNullable<AIMessage["tool_calls"]>[number];

/** The tool calls a model message's own content blocks still name. */
function contentToolCalls(message: AIMessage): ToolCall[] {
  if (!Array.isArray(message.content)) {
    return [];
  }
  return message.content.flatMap((block) => {
    const record = block as Record<string, unknown>;
    return record.type === "tool_call" &&
      typeof record.id === "string" &&
      typeof record.name === "string"
      ? [
          {
            type: "tool_call" as const,
            id: record.id,
            name: record.name,
            args: (record.args as Record<string, unknown> | undefined) ?? {},
          },
        ]
      : [];
  });
}

/**
 * The assistant message as the model produced it: calls its content blocks
 * name but `tool_calls` dropped are put back.
 */
function restoreModelToolCalls(message: AIMessage): AIMessage {
  const current = message.tool_calls ?? [];
  const dropped = contentToolCalls(message).filter(
    (block) => !current.some((call) => call.id === block.id),
  );
  if (dropped.length === 0) {
    return message;
  }
  return new AIMessage({
    content: message.content,
    tool_calls: [...current, ...dropped],
    invalid_tool_calls: message.invalid_tool_calls,
    additional_kwargs: message.additional_kwargs,
    response_metadata: message.response_metadata,
    usage_metadata: message.usage_metadata,
    id: message.id,
    name: message.name,
  });
}

/**
 * Keep every assistant tool-calling message as the model produced it and give
 * each of its calls a result, adding a "not run" ToolMessage after the ones
 * that already answer it.
 *
 * LangChain's human-in-the-loop middleware, on a batch where any call is
 * rejected, keeps only the rejected calls and jumps back to the model: it
 * reassigns the message's `tool_calls`, so an approved call from that batch
 * silently disappears while its content block stays. A provider then sees a
 * message the model never produced. DeepSeek accepts its own recent
 * tool-calling message without its reasoning, but a changed one needs
 * `reasoning_content`, which LangChain never sends back, so the resumed turn
 * fails. Restoring the call (the content block still names it) and answering
 * it keeps the message intact and tells the model the plain truth: the call
 * did not run, so it can call it again.
 */
export function answerUnansweredToolCalls(
  messages: readonly BaseMessage[],
): readonly BaseMessage[] {
  const answered = new Set(
    messages
      .filter(ToolMessage.isInstance)
      .map((message) => message.tool_call_id),
  );
  let changed = false;
  const result: BaseMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const original = messages[index]!;
    if (!AIMessage.isInstance(original)) {
      result.push(original);
      continue;
    }
    const message = restoreModelToolCalls(original);
    changed ||= message !== original;
    result.push(message);
    if (!message.tool_calls?.length) {
      continue;
    }
    // Keep the results that already follow this message, then add the missing.
    while (
      index + 1 < messages.length &&
      ToolMessage.isInstance(messages[index + 1])
    ) {
      index += 1;
      result.push(messages[index]!);
    }
    for (const call of message.tool_calls) {
      if (!call.id || answered.has(call.id)) {
        continue;
      }
      answered.add(call.id);
      changed = true;
      result.push(
        new ToolMessage({
          tool_call_id: call.id,
          name: call.name,
          content: UNANSWERED_TOOL_CALL_RESULT,
          status: "error",
        }),
      );
    }
  }
  return changed ? result : messages;
}

export function createSourceWeftUnansweredToolCallsMiddleware() {
  return createMiddleware({
    name: "SourceWeftUnansweredToolCalls",
    wrapModelCall: (request, handler) => {
      const messages = answerUnansweredToolCalls(request.messages);
      return messages === request.messages
        ? handler(request)
        : handler({ ...request, messages: [...messages] });
    },
  });
}
