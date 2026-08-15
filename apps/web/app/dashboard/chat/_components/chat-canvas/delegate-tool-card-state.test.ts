import assert from "node:assert/strict";
import { test } from "vitest";
import type { ToolCallRecord } from "./types";
import {
  extractReport,
  isDelegateToolName,
  parseDelegateToolCall,
} from "./delegate-tool-card-state";

function toolCall(input: Partial<ToolCallRecord>): ToolCallRecord {
  return {
    id: "call_1",
    tool: "task",
    input: {},
    output: undefined,
    status: "running",
    ...input,
  } as ToolCallRecord;
}

test("isDelegateToolName matches only the task tool", () => {
  assert.equal(isDelegateToolName("task"), true);
  assert.equal(isDelegateToolName("write_file"), false);
  assert.equal(isDelegateToolName("search_sources"), false);
});

test("parseDelegateToolCall reads the delegate type and prompt from args", () => {
  const view = parseDelegateToolCall(
    toolCall({
      input: { subagent_type: "explore", description: "find the facts" },
      status: "running",
    }),
  );
  assert.equal(view.subagentType, "explore");
  assert.equal(view.prompt, "find the facts");
  assert.equal(view.status, "running");
  assert.equal(view.report, null);
});

test("parseDelegateToolCall falls back to a generic delegate label", () => {
  const view = parseDelegateToolCall(toolCall({ input: {} }));
  assert.equal(view.subagentType, "subagent");
  assert.equal(view.prompt, "");
});

test("extractReport handles string, {summary}, and structured output", () => {
  assert.equal(extractReport("done"), "done");
  assert.equal(extractReport(""), null);
  assert.equal(extractReport(null), null);
  assert.equal(extractReport({ summary: "the answer" }), "the answer");
  assert.equal(
    extractReport({ findings: [] }),
    JSON.stringify({ findings: [] }),
  );
});

test("parseDelegateToolCall surfaces a completed report", () => {
  const view = parseDelegateToolCall(
    toolCall({
      input: { subagent_type: "plan", description: "plan it" },
      output: { summary: "step 1, step 2" },
      status: "completed",
    }),
  );
  assert.equal(view.report, "step 1, step 2");
  assert.equal(view.status, "completed");
});
