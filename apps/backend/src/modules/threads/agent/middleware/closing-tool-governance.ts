import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { Command, StateSchema, ReducedValue } from "@langchain/langgraph";
import { createMiddleware } from "langchain";
import { z } from "zod/v4";
import {
  getAgentStepClosingToolIds,
  assertAgentStepIdentity,
  currentAgentStepScope,
  isAgentStepClosing,
  isAgentStepFinalizing,
  selectAgentStepStops,
} from "./step-budget";

// These are the actual host/SDK capability expansion entries. Existing mounted
// skill files and authorized connector actions remain available. This does not
// attempt to classify the intent of arbitrary shell commands.
export const CLOSING_BLOCKED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "task",
  "install_skill",
  "enable_skill",
]);

export function agentModelToolName(tool: unknown): string | null {
  if (!tool || typeof tool !== "object") return null;
  const value = tool as { name?: unknown; function?: { name?: unknown } };
  return typeof value.name === "string"
    ? value.name
    : typeof value.function?.name === "string"
      ? value.function.name
      : null;
}

export function createSourceWeftClosingToolGovernanceMiddleware(input: {
  userMessageId?: string | null;
}) {
  const key = "sourceweftPartialTaskResults";
  const partials = z.record(z.string(), z.string());
  return createMiddleware({
    stateSchema: new StateSchema({
      [key]: new ReducedValue(partials.default({}), {
        reducer: (
          current: Record<string, string>,
          update: Record<string, string>,
        ) => {
          // A replay result belongs to one trusted user turn. A new turn drops
          // old entries; same-turn parallel child updates still merge.
          const retained = Object.fromEntries(
            Object.entries({ ...current, ...update }).filter(([identity]) => {
              const parsed: unknown = JSON.parse(identity);
              return Array.isArray(parsed) && parsed[0] === input.userMessageId;
            }),
          );
          return retained;
        },
      }),
    }),
    name: "SourceWeftClosingToolGovernance",
    beforeAgent: () => ({ [key]: {} }),
    wrapModelCall: async (request, handler) => {
      if (input.userMessageId)
        assertAgentStepIdentity(request.state, input.userMessageId);
      if (isAgentStepFinalizing(request.state))
        return handler({ ...request, tools: [], toolChoice: "none" });
      if (!isAgentStepClosing(request.state)) return handler(request);
      const ids = getAgentStepClosingToolIds(request.state);
      if (!ids) throw new Error("Agent closing tool snapshot is missing.");
      const allowed = new Set(ids);
      return handler({
        ...request,
        toolChoice: "auto",
        tools: request.tools.filter((tool) => {
          const name = agentModelToolName(tool);
          return (
            name !== null &&
            allowed.has(name) &&
            !CLOSING_BLOCKED_TOOL_NAMES.has(name)
          );
        }),
      });
    },
    wrapToolCall: async (request, handler) => {
      if (input.userMessageId)
        assertAgentStepIdentity(request.state, input.userMessageId);
      if (
        request.toolCall.name === "task" &&
        (!input.userMessageId || !request.toolCall.id)
      ) {
        return new ToolMessage({
          content:
            "[AGENT_TASK_IDENTITY_REQUIRED] Delegation requires a user-turn and native tool-call identity; no child was started.",
          tool_call_id: request.toolCall.id ?? "",
          name: "task",
          status: "error",
        });
      }
      if (request.toolCall.name === "task") {
        const decision = [...request.state.messages]
          .reverse()
          .find((message) => AIMessage.isInstance(message));
        if (
          AIMessage.isInstance(decision) &&
          decision.tool_calls?.filter((call) => call.id === request.toolCall.id)
            .length! > 1
        ) {
          return new ToolMessage({
            content:
              "[AGENT_TASK_IDENTITY_DUPLICATE] This decision reused a tool-call identity. No child was started; issue distinct native tool-call identities for distinct tasks.",
            tool_call_id: request.toolCall.id ?? "",
            name: "task",
            status: "error",
          });
        }
      }
      const closing = isAgentStepClosing(request.state);
      const ids = closing ? getAgentStepClosingToolIds(request.state) : null;
      const name = request.toolCall.name;
      if (
        isAgentStepFinalizing(request.state) ||
        (closing &&
          (!ids || !ids.includes(name) || CLOSING_BLOCKED_TOOL_NAMES.has(name)))
      ) {
        return new ToolMessage({
          content: `[AGENT_CLOSING_TOOL_DENIED] Tool '${name}' is unavailable in this run phase. Continue completing the existing delivery with the remaining authorized tools.`,
          tool_call_id: request.toolCall.id ?? "",
          name,
          status: "error",
        });
      }
      const taskIdentity =
        input.userMessageId && request.toolCall.id
          ? JSON.stringify([
              input.userMessageId,
              currentAgentStepScope(),
              request.toolCall.id,
            ])
          : null;
      const saved =
        name === "task" && taskIdentity
          ? request.state[key]?.[taskIdentity]
          : undefined;
      if (saved)
        return new ToolMessage({
          content: saved,
          name,
          tool_call_id: request.toolCall.id ?? "",
        });
      const result = await handler(request);
      if (
        name !== "task" ||
        !input.userMessageId ||
        !(result instanceof Command)
      )
        return result;
      const update = result.update;
      if (!update || typeof update !== "object" || Array.isArray(update))
        return result;
      const previous = new Set(
        selectAgentStepStops(request.state, {
          userMessageId: input.userMessageId,
        }).map((stop) => stop.scope),
      );
      const stops = selectAgentStepStops(update, {
        userMessageId: input.userMessageId,
      }).filter((stop) => stop.scope !== "main" && !previous.has(stop.scope));
      if (!stops.length) return result;
      const messages = (update as { messages?: unknown[] }).messages;
      if (!Array.isArray(messages)) return result;
      // Keep the native Command and state merge, but make partial completion
      // machine-readable to the parent. Never infer status from model prose.
      const partial = JSON.stringify({
        status: "partial",
        reason: "step_limit",
        results: stops.map(({ agentRunStop, summaryText }) => ({
          agentRunStop,
          summaryText,
        })),
      });
      return new Command({
        ...result,
        update: {
          ...update,
          ...(taskIdentity ? { [key]: { [taskIdentity]: partial } } : {}),
          messages: messages.map((message) => {
            if (
              !ToolMessage.isInstance(message) ||
              message.tool_call_id !== request.toolCall.id
            )
              return message;
            return new ToolMessage({
              ...message,
              content: partial,
              artifact: {
                status: "partial",
                reason: "step_limit",
                results: stops.map(({ agentRunStop, summaryText }) => ({
                  agentRunStop,
                  summaryText,
                })),
              },
            });
          }),
        },
      });
    },
  });
}
