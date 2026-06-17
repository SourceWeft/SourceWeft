import assert from "node:assert/strict";
import { test } from "vitest";
import type { MessageRenderBlock, ToolCallRecord } from "./types";
import { shouldWorkflowAccordionDefaultOpen } from "./assistant-workflow-state";

function toolCall(input: {
  approvalState?: ToolCallRecord["approvalState"];
  id?: string;
  status: ToolCallRecord["status"];
}): ToolCallRecord {
  return {
    id: input.id ?? "tool_1",
    tool: "search_notion_pages",
    input: {},
    output: null,
    latencyMs: null,
    status: input.status,
    error: input.status === "error" ? "failed" : null,
    ...(input.approvalState ? { approvalState: input.approvalState } : {}),
  };
}

const toolBlock: MessageRenderBlock = {
  id: "block_tool_1",
  toolCallId: "tool_1",
  type: "tool",
};

test("shouldWorkflowAccordionDefaultOpen expands running workflows", () => {
  assert.equal(
    shouldWorkflowAccordionDefaultOpen({
      blocks: [toolBlock],
      isRunning: true,
      toolCalls: [toolCall({ status: "completed" })],
    }),
    true,
  );
});

test("shouldWorkflowAccordionDefaultOpen collapses successful terminal workflows", () => {
  assert.equal(
    shouldWorkflowAccordionDefaultOpen({
      blocks: [toolBlock],
      isRunning: false,
      toolCalls: [toolCall({ status: "completed" })],
    }),
    false,
  );
});

test("shouldWorkflowAccordionDefaultOpen expands failed approval and rejected terminal workflows", () => {
  for (const call of [
    toolCall({ status: "error" }),
    toolCall({ status: "approval_requested" }),
    toolCall({ approvalState: "rejected", status: "completed" }),
  ]) {
    assert.equal(
      shouldWorkflowAccordionDefaultOpen({
        blocks: [toolBlock],
        isRunning: false,
        toolCalls: [call],
      }),
      true,
    );
  }
});

test("shouldWorkflowAccordionDefaultOpen expands pending approval terminal workflows", () => {
  assert.equal(
    shouldWorkflowAccordionDefaultOpen({
      blocks: [toolBlock],
      isRunning: false,
      toolCalls: [toolCall({ status: "approval_requested" })],
    }),
    true,
  );
});
