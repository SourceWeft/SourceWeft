import { createMiddleware } from "langchain";

export type CommandExecutionPolicy = {
  initialToolPolicy: "auto" | { kind: "force"; toolName: string };
  toolPolicy?: {
    allow?: readonly string[];
    deny: readonly string[];
  };
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

function commandModelToolName(tool: unknown) {
  return tool &&
    typeof tool === "object" &&
    !Array.isArray(tool) &&
    "name" in tool &&
    typeof tool.name === "string"
    ? tool.name
    : null;
}

export function filterCommandModelTools<Tool>(
  tools: readonly Tool[],
  policy: CommandExecutionPolicy["toolPolicy"],
) {
  if (!policy) {
    return [...tools];
  }
  const allowed = policy.allow ? new Set(policy.allow) : null;
  const denied = new Set(policy.deny);
  return tools.filter((tool) => {
    const name = commandModelToolName(tool);
    return name
      ? !denied.has(name) && (!allowed || allowed.has(name))
      : allowed === null;
  });
}

export function createCommandToolChoiceMiddleware(
  policy: CommandExecutionPolicy,
) {
  return createMiddleware({
    name: "SourceWeftCommandToolChoice",
    wrapModelCall: async (request, handler) => {
      const tools = filterCommandModelTools(request.tools, policy.toolPolicy);
      if (policy.initialToolPolicy === "auto") {
        return handler({ ...request, tools });
      }
      const targetToolName = policy.initialToolPolicy.toolName;
      const targetTool = tools.find(
        (tool) => commandModelToolName(tool) === targetToolName,
      );
      if (!targetTool) {
        throw new Error(
          `Command initial tool '${targetToolName}' is not available under the command tool policy.`,
        );
      }

      const priorTargetCalled = hasToolCallNamed(
        request.state.messages,
        targetToolName,
      );
      const commandRequest = {
        ...request,
        tools,
        modelSettings: {
          ...request.modelSettings,
          parallel_tool_calls: false,
        },
      };
      if (priorTargetCalled) {
        return handler(commandRequest);
      }

      const response = await handler({
        ...commandRequest,
        tools: [targetTool],
        toolChoice: forcedToolChoice(targetToolName),
      });
      const responseCalls = messageToolCalls(response);
      if (responseCalls.length > 0) {
        return response;
      }

      return handler({
        ...commandRequest,
        tools: [targetTool],
        toolChoice: forcedToolChoice(targetToolName),
      });
    },
  });
}
