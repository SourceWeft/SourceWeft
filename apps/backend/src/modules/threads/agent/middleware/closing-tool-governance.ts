import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { Command, StateSchema, ReducedValue } from "@langchain/langgraph";
import { createMiddleware } from "langchain";
import { z } from "zod/v4";
import { readAgentRunStop } from "@sourceweft/contracts";
import {
  getAgentStepClosingToolIds,
  assertAgentStepIdentity,
  currentAgentStepScope,
  isAgentStepClosing,
  isAgentStepFinalizing,
  selectAgentStepStops,
  readAgentStepTaskFailure,
  readAgentStepBudgetForRefresh,
} from "./step-budget";
import {
  COMMITTED_DELIVERY_BLOCKED_TOOL_NAMES,
  readCommittedDelivery,
} from "./committed-delivery";

const FAILED_CHILD_SUMMARY_TEXT =
  "The child reached its execution budget, but its progress summary failed. Existing tool effects are not proof of verified completion or publication. The parent may inspect and integrate existing work; this same task will not restart.";

/** Strict inspection of server-created partial receipts when rolling back messages. */
export function readAgentPartialTasksForRefresh(
  state: unknown,
  userMessageId: string,
): Record<string, string> {
  const obj =
    state && typeof state === "object"
      ? (state as Record<string, unknown>)
      : {};
  const raw = obj.sourceweftPartialTaskResults;
  if (raw == null) return {};
  if (typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Invalid saved partial task receipts");
  const selected: Record<string, string> = {};
  for (const [identity, value] of Object.entries(raw)) {
    let ids: unknown;
    try {
      ids = JSON.parse(identity);
    } catch {
      throw new Error("Invalid saved partial task identity");
    }
    if (
      !Array.isArray(ids) ||
      ids.length !== 3 ||
      ids.some((id) => typeof id !== "string" || !id)
    )
      throw new Error("Invalid saved partial task identity");
    if (ids[0] !== userMessageId) continue;
    if (typeof value !== "string")
      throw new Error("Invalid saved partial task receipt");
    let decoded: unknown;
    try {
      decoded = JSON.parse(value);
    } catch {
      throw new Error("Invalid saved partial task receipt");
    }
    const result = z
      .object({
        status: z.literal("partial"),
        reason: z.literal("step_limit"),
        results: z
          .array(
            z
              .object({
                agentRunStop: z.unknown(),
                summaryText: z.string().trim().min(1).max(16000),
              })
              .strict(),
          )
          .min(1),
      })
      .strict()
      .safeParse(decoded);
    if (
      !result.success ||
      result.data.results.some((item) => {
        const stop = readAgentRunStop(item.agentRunStop);
        return !stop;
      })
    )
      throw new Error("Invalid saved partial task receipt");
    const budget = readAgentStepBudgetForRefresh(state, userMessageId);
    if (
      !budget ||
      !result.data.results.every((item) => {
        const stop = readAgentRunStop(item.agentRunStop)!;
        return Object.entries(budget.scopes).some(([scope, entry]) => {
          const child =
            ids[1] === "main"
              ? scope.startsWith("graph:")
              : scope.startsWith(`${ids[1]}|`);
          if (
            !child ||
            entry.steps !== stop.steps ||
            entry.limit !== stop.limit
          )
            return false;
          if ("policyVersion" in entry) {
            if (
              !("policyVersion" in stop) ||
              stop.policyVersion !== 2 ||
              entry.normalSteps !== stop.normalSteps ||
              entry.normalLimit !== stop.normalLimit ||
              entry.closingSteps !== stop.closingSteps ||
              entry.closingLimit !== stop.closingLimit
            )
              return false;
          } else if ("policyVersion" in stop) return false;
          return stop.summaryStatus === "completed"
            ? entry.summary === "completed" &&
                entry.summaryText === item.summaryText
            : entry.summary === "reserved" &&
                item.summaryText === FAILED_CHILD_SUMMARY_TEXT;
        });
      })
    )
      throw new Error(
        "Saved partial task receipt has no matching exhausted child scope",
      );
    selected[identity] = value;
  }
  return selected;
}

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
      const committed = readCommittedDelivery(request.state.messages) !== null;
      const withdrawn = (name: string) =>
        committed && COMMITTED_DELIVERY_BLOCKED_TOOL_NAMES.has(name);
      if (!isAgentStepClosing(request.state))
        return handler(
          committed
            ? {
                ...request,
                tools: request.tools.filter((tool) => {
                  const name = agentModelToolName(tool);
                  return name === null || !withdrawn(name);
                }),
              }
            : request,
        );
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
            !CLOSING_BLOCKED_TOOL_NAMES.has(name) &&
            !withdrawn(name)
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
          (decision.tool_calls?.filter(
            (call) => call.id === request.toolCall.id,
          ).length ?? 0) > 1
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
        COMMITTED_DELIVERY_BLOCKED_TOOL_NAMES.has(name) &&
        readCommittedDelivery(request.state.messages) !== null
      ) {
        return new ToolMessage({
          content: `[AGENT_DELIVERY_COMMITTED] Tool '${name}' is unavailable after this turn's deliverable was committed. Reply to the user with the final summary now.`,
          tool_call_id: request.toolCall.id ?? "",
          name,
          status: "error",
        });
      }
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
          status: JSON.parse(saved).results.some(
            (item: { agentRunStop: { summaryStatus: string } }) =>
              item.agentRunStop.summaryStatus === "failed",
          )
            ? "error"
            : "success",
        });
      let result: Awaited<ReturnType<typeof handler>>;
      try {
        result = await handler(request);
      } catch (error) {
        const failure =
          name === "task" && input.userMessageId && taskIdentity
            ? readAgentStepTaskFailure(error, {
                userMessageId: input.userMessageId,
                parentScope: currentAgentStepScope(),
              })
            : null;
        if (!failure) throw error;
        if ("priorityError" in failure) throw failure.priorityError;
        const partial = {
          status: "partial",
          reason: "step_limit",
          results: [
            {
              agentRunStop: failure.agentRunStop,
              summaryText: FAILED_CHILD_SUMMARY_TEXT,
            },
          ],
        };
        const content = JSON.stringify(partial);
        return new Command({
          update: {
            sourceweftRunStepBudget: failure.budget,
            [key]: { [taskIdentity!]: content },
            messages: [
              new ToolMessage({
                content,
                artifact: partial,
                name,
                tool_call_id: request.toolCall.id ?? "",
                status: "error",
              }),
            ],
          },
        });
      }
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
