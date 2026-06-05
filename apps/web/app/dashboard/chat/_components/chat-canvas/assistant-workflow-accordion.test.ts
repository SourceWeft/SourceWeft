import assert from "node:assert/strict";
import { test } from "vitest";
import type { MessageRenderBlock, MessageVersion, ToolCallRecord } from "./types";
import { shouldWorkflowAccordionDefaultOpen } from "./assistant-workflow-state";

function version(toolCall: ToolCallRecord): MessageVersion {
  return {
    id: "message_1",
    content: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    toolCalls: [toolCall],
  } as MessageVersion;
}

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
      version: version(toolCall({ status: "completed" })),
    }),
    true,
  );
});

test("shouldWorkflowAccordionDefaultOpen collapses successful terminal workflows", () => {
  assert.equal(
    shouldWorkflowAccordionDefaultOpen({
      blocks: [toolBlock],
      isRunning: false,
      version: version(toolCall({ status: "completed" })),
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
        version: version(call),
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
      version: version(toolCall({ status: "approval_requested" })),
    }),
    true,
  );
});
