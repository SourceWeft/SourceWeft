import assert from "node:assert/strict";
import { ToolCallLimitExceededError } from "langchain";
import { test } from "vitest";
import {
  AGENT_TOOL_BUDGET_EXCEEDED,
  toAgentToolBudgetContentError,
} from "./tool-call-budget";

// Legacy in-flight SDK errors keep their safe classification; the global
// tool-call gate itself has been retired in favor of logical model steps.
test("only typed SDK budget errors and their wrapped causes get safe non-retryable classification", () => {
  const source = new ToolCallLimitExceededError(
    3,
    2,
    2,
    9,
    "private-tool-secret",
  );
  const cycle: { cause?: unknown; error?: unknown } = {};
  cycle.cause = cycle;
  cycle.error = source;
  for (const error of [
    source,
    new Error("private-wrapper", { cause: source }),
    { error: source },
    cycle,
  ]) {
    const mapped = toAgentToolBudgetContentError(error);
    assert.equal(mapped?.statusCode, 409);
    assert.equal(mapped?.code, AGENT_TOOL_BUDGET_EXCEEDED);
    assert.deepEqual(mapped?.details, { scope: "thread", retryable: false });
    assert.equal(mapped?.recoverable, false);
    assert.doesNotMatch(mapped?.message ?? "", /private|secret/);
  }
  for (const error of [
    new Error("Tool call limit exceeded"),
    { name: "ToolCallLimitExceededError", threadCount: 300 },
    new Error("ordinary execute failure"),
  ]) {
    assert.equal(toAgentToolBudgetContentError(error), null);
  }
});
