import {
  createMiddleware,
  ToolCallLimitExceededError,
  toolCallLimitMiddleware,
} from "langchain";
import { withLangGraph } from "@langchain/langgraph/zod";
import { z } from "zod/v4";
import { config } from "../../../../shared/config";
import { ContentError } from "../../../content/errors";

export const AGENT_TOOL_BUDGET_EXCEEDED = "AGENT_TOOL_BUDGET_EXCEEDED";

/**
 * Every prepared turn builds fresh middleware with its trusted user-message ID.
 * Late child projections may carry an older marker; only this turn's ID may
 * update the channel. Empty/default/foreign writes cannot roll it back.
 */
export function createSourceWeftGlobalToolCallLimitMiddleware(
  input: {
    userMessageId?: string | null;
  } = {},
) {
  const turnId = input.userMessageId?.trim() ? input.userMessageId : null;
  const marker = z.string().nullable();
  const defaulted = marker.default(null);
  const turnBoundary = createMiddleware({
    name: "SourceWeftToolBudgetTurn",
    stateSchema: z.object({
      sourceweftToolBudgetTurnId: withLangGraph(
        defaulted as unknown as typeof marker,
        {
          reducer: {
            fn: (current: string | null, update: string | null) =>
              turnId !== null && update === turnId ? turnId : (current ?? null),
          },
          default: () => null,
        },
      ),
    }),
    beforeAgent: (state) => {
      if (!turnId || state.sourceweftToolBudgetTurnId === turnId) return;
      const previous = state.sourceweftToolBudgetTurnId;
      // Legacy checkpoints bind a marker without clearing an interrupted run's
      // budget. Only a positively identified new user turn gets a fresh run
      // budget; thread counts, retries and HITL continuations stay untouched.
      return {
        sourceweftToolBudgetTurnId: turnId,
        ...(typeof previous === "string" && previous.length > 0
          ? { runToolCallCount: {} }
          : {}),
      };
    },
  });
  return [
    turnBoundary,
    toolCallLimitMiddleware({
      runLimit: config.chat.agent.toolCallRunLimit,
      threadLimit: config.chat.agent.toolCallThreadLimit,
      exitBehavior: "error",
    }),
  ];
}

function findBudgetError(
  error: unknown,
  seen = new Set<unknown>(),
): ToolCallLimitExceededError | null {
  if (!error || seen.has(error)) return null;
  seen.add(error);
  if (error instanceof ToolCallLimitExceededError) return error;
  if (typeof error !== "object") return null;
  const record = error as { cause?: unknown; error?: unknown };
  return (
    findBudgetError(record.cause, seen) ?? findBudgetError(record.error, seen)
  );
}

/** Preserve only typed SDK budget failures; arbitrary tool error text is not authority. */
export function toAgentToolBudgetContentError(
  error: unknown,
): ContentError | null {
  const budget = findBudgetError(error);
  if (!budget) return null;
  const thread =
    budget.threadLimit !== undefined && budget.threadCount > budget.threadLimit;
  const run =
    budget.runLimit !== undefined && budget.runCount > budget.runLimit;
  const scope =
    thread && run
      ? "thread_and_run"
      : thread
        ? "thread"
        : run
          ? "run"
          : "agent";
  const message = thread
    ? "This conversation has reached its tool-call limit. The remaining work was not completed. Start a new conversation to continue from saved work."
    : "This request has reached its tool-call limit. The remaining work was not completed. Split it into smaller follow-up requests.";
  return new ContentError(409, AGENT_TOOL_BUDGET_EXCEEDED, message, {
    recoverable: false,
    details: { scope, retryable: false },
  });
}
