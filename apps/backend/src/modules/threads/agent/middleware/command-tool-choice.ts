import { createMiddleware } from "langchain";

export type CommandExecutionPolicy = {
  targetToolName: string;
};

type LangChainToolChoice =
  | "none"
  | "auto"
  | "required"
  | { type: "function"; function: { name: string } };

function isToolChoiceTargetCall(value: unknown, targetToolName: string) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { name?: unknown }).name === targetToolName
  );
}

export function messageToolCalls(message: unknown) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return [];
  }
  const record = message as {
    additional_kwargs?: { tool_calls?: unknown };
    toolCalls?: unknown;
    tool_calls?: unknown;
  };
  const directCalls = Array.isArray(record.tool_calls)
    ? record.tool_calls
    : Array.isArray(record.toolCalls)
      ? record.toolCalls
      : [];
  const additionalCalls = Array.isArray(record.additional_kwargs?.tool_calls)
    ? record.additional_kwargs.tool_calls
    : [];
  return [...directCalls, ...additionalCalls];
}

export function hasToolCallNamed(messages: unknown[], toolName: string) {
  return messages.some((message) =>
    messageToolCalls(message).some((call) => {
      if (isToolChoiceTargetCall(call, toolName)) {
        return true;
      }
      const fn =
        call && typeof call === "object" && !Array.isArray(call)
          ? (call as { function?: { name?: unknown } }).function
          : null;
      return fn?.name === toolName;
    }),
  );
}

export function forcedToolChoice(toolName: string): LangChainToolChoice {
  return {
    type: "function",
    function: { name: toolName },
  };
}

export function createCommandToolChoiceMiddleware(
  policy: CommandExecutionPolicy,
) {
  return createMiddleware({
    name: "SourceWeftCommandToolChoice",
    wrapModelCall: async (request, handler) => {
      const targetTool = request.tools.find(
        (tool) => tool.name === policy.targetToolName,
      );
      if (!targetTool) {
        throw new Error(
          `Command target tool '${policy.targetToolName}' is not bound to the model request.`,
        );
      }

      const priorTargetCalled = hasToolCallNamed(
        request.state.messages,
        policy.targetToolName,
      );
      if (priorTargetCalled) {
        return handler(request);
      }

      const response = await handler({
        ...request,
        tools: [targetTool],
        toolChoice: forcedToolChoice(policy.targetToolName),
      });
      const responseCalls = messageToolCalls(response);
      if (responseCalls.length > 0) {
        return response;
      }

      return handler({
        ...request,
        tools: [targetTool],
        toolChoice: forcedToolChoice(policy.targetToolName),
      });
    },
  });
}
