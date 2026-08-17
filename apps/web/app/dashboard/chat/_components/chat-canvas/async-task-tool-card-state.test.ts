import assert from "node:assert/strict";
import { test } from "vitest";
import type { ToolCallRecord } from "./types";
import {
  isAsyncTaskToolName,
  parseAsyncTaskToolCall,
} from "./async-task-tool-card-state";

function toolCall(input: Partial<ToolCallRecord>): ToolCallRecord {
  return {
    id: "call_1",
    tool: "start_async_task",
    input: {},
    output: undefined,
    status: "completed",
    ...input,
  } as ToolCallRecord;
}

test("isAsyncTaskToolName matches the five async task tools only", () => {
  for (const name of [
    "start_async_task",
    "check_async_task",
    "update_async_task",
    "cancel_async_task",
    "list_async_tasks",
  ]) {
    assert.equal(isAsyncTaskToolName(name), true);
  }
  assert.equal(isAsyncTaskToolName("task"), false);
  assert.equal(isAsyncTaskToolName("search_sources"), false);
});

test("start: reads agent + brief from args and the taskId from the output", () => {
  const view = parseAsyncTaskToolCall(
    toolCall({
      tool: "start_async_task",
      input: { agentName: "explore-async", description: "investigate auth" },
      output: "Launched async subagent. taskId: thread_abc",
    }),
  );
  assert.equal(view.verb, "start");
  assert.equal(view.agentName, "explore-async");
  assert.equal(view.instructions, "investigate auth");
  assert.equal(view.taskId, "thread_abc");
});

test("check: parses the endpoint's JSON status + result", () => {
  const view = parseAsyncTaskToolCall(
    toolCall({
      tool: "check_async_task",
      input: { taskId: "thread_abc" },
      output: JSON.stringify({
        status: "success",
        threadId: "thread_abc",
        result: "found it in session.ts",
      }),
    }),
  );
  assert.equal(view.verb, "check");
  assert.equal(view.reportedStatus, "success");
  assert.equal(view.result, "found it in session.ts");
  assert.equal(view.taskId, "thread_abc");
});

test("check: a still-running task reports its status without a result", () => {
  const view = parseAsyncTaskToolCall(
    toolCall({
      tool: "check_async_task",
      input: { taskId: "thread_abc" },
      output: JSON.stringify({ status: "running", threadId: "thread_abc" }),
      status: "completed",
    }),
  );
  assert.equal(view.reportedStatus, "running");
  assert.equal(view.result, null);
});

test("update: surfaces the follow-up message", () => {
  const view = parseAsyncTaskToolCall(
    toolCall({
      tool: "update_async_task",
      input: { taskId: "thread_abc", message: "also cover refresh tokens" },
      output: "Updated async subagent. taskId: thread_abc",
    }),
  );
  assert.equal(view.verb, "update");
  assert.equal(view.instructions, "also cover refresh tokens");
  assert.equal(view.taskId, "thread_abc");
});

test("cancel + list are recognised with their verbs", () => {
  const cancel = parseAsyncTaskToolCall(
    toolCall({
      tool: "cancel_async_task",
      input: { taskId: "thread_abc" },
      output: "Cancelled async subagent task: thread_abc",
    }),
  );
  assert.equal(cancel.verb, "cancel");
  assert.equal(cancel.taskId, "thread_abc");

  const list = parseAsyncTaskToolCall(
    toolCall({
      tool: "list_async_tasks",
      input: {},
      output: "2 tracked task(s):\n- taskId: a\n- taskId: b",
    }),
  );
  assert.equal(list.verb, "list");
  assert.ok(list.listing?.includes("2 tracked task(s)"));
});
