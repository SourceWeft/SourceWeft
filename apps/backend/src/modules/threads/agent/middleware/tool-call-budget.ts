import { ToolCallLimitExceededError } from "langchain";
import { ContentError } from "../../../content/errors";

export const AGENT_TOOL_BUDGET_EXCEEDED = "AGENT_TOOL_BUDGET_EXCEEDED";

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
