import assert from "node:assert/strict";
import { test } from "vitest";
import type { AssistantWorkflowBlock } from "./assistant-render-segments";
import type { WorkflowRenderItem } from "./subagent-grouping";
import type { ToolCallRecord } from "./types";
import {
  groupWorkflowToolRuns,
  isGroupableToolCall,
  type WorkflowDisplayItem,
} from "./workflow-tool-groups";

function tool(id: string): AssistantWorkflowBlock {
  return { id, toolCallId: id, type: "tool" } as AssistantWorkflowBlock;
}

function reasoning(id: string): AssistantWorkflowBlock {
  return { id, text: "thinking", type: "reasoning" } as AssistantWorkflowBlock;
}

function blocks(...list: AssistantWorkflowBlock[]): WorkflowRenderItem[] {
  return list.map((block, index) => ({ block, index, kind: "block" }));
}

function shape(items: WorkflowDisplayItem[]) {
  return items.map((item) =>
    item.kind === "tool-group"
      ? `group(${item.entries.map((entry) => entry.block.id).join(",")})`
      : item.kind === "block"
        ? item.block.id
        : item.kind,
  );
}

const groupAll = () => true;

test("two or more consecutive tool calls form a group", () => {
  assert.deepEqual(
    shape(groupWorkflowToolRuns(blocks(tool("a"), tool("b"), tool("c")), groupAll)),
    ["group(a,b,c)"],
  );
});

test("a single tool call renders as itself", () => {
  assert.deepEqual(
    shape(groupWorkflowToolRuns(blocks(reasoning("r"), tool("a")), groupAll)),
    ["r", "a"],
  );
});

test("reasoning between calls joins the group, leading and trailing stays out", () => {
  assert.deepEqual(
    shape(
      groupWorkflowToolRuns(
        blocks(reasoning("r1"), tool("a"), reasoning("r2"), tool("b"), reasoning("r3")),
        groupAll,
      ),
    ),
    ["r1", "group(a,r2,b)", "r3"],
  );
});

test("standalone calls split runs and stay visible", () => {
  assert.deepEqual(
    shape(
      groupWorkflowToolRuns(
        blocks(tool("a"), tool("b"), tool("ask"), tool("c"), tool("d")),
        (entry) => entry.block.id !== "ask",
      ),
    ),
    ["group(a,b)", "ask", "group(c,d)"],
  );
});

test("delegates and non-tool blocks end a run", () => {
  const items: WorkflowRenderItem[] = [
    ...blocks(tool("a"), tool("b")),
    {
      entries: [],
      key: "delegate:t",
      kind: "delegate",
      taskBlock: { block: tool("t"), index: 2 },
      taskCallId: "t",
    },
    { block: { id: "art", type: "artifact_output" } as AssistantWorkflowBlock, index: 3, kind: "block" },
    ...blocks(tool("c")),
  ];
  assert.deepEqual(shape(groupWorkflowToolRuns(items, groupAll)), [
    "group(a,b)",
    "delegate",
    "art",
    "c",
  ]);
});

function toolCall(input: Partial<ToolCallRecord>): ToolCallRecord {
  return {
    error: null,
    id: "call-1",
    input: {},
    latencyMs: 1,
    output: null,
    status: "completed",
    tool: "execute",
    ...input,
  };
}

const pendingConfirmation = {
  type: "tool_confirmation_request",
  schemaVersion: 1,
  id: "approval-1",
  domain: "connector",
  subject: { label: "Gmail", provider: "gmail", connectorId: "c-1" },
  action: {
    type: "send",
    toolName: "send_gmail_message",
    label: "Send",
    riskLevel: "high",
    status: "proposed",
    requiresApproval: true,
  },
  preview: { title: "Send email" },
  decisionOptions: [
    { decision: "approve", label: "Approve" },
    { decision: "reject", label: "Reject" },
  ],
  execution: {
    providerStatus: "not_executed",
    executor: {
      kind: "connector_action_run",
      connectorId: "c-1",
      actionRunId: "r-1",
    },
  },
  status: "proposed",
  userMessage: "Waiting for confirmation.",
};

test("calls waiting on the user are never grouped", () => {
  assert.equal(isGroupableToolCall(toolCall({})), true);
  assert.equal(isGroupableToolCall(toolCall({ status: "error" })), true);
  assert.equal(isGroupableToolCall(toolCall({ tool: "askUser" })), false);
  const pending = toolCall({
    output: pendingConfirmation,
    status: "approval_requested",
    tool: "send_gmail_message",
  });
  assert.equal(isGroupableToolCall(pending), false);
  assert.equal(
    isGroupableToolCall(pending, [
      { confirmationId: "approval-1", decision: "reject", expired: true },
    ]),
    true,
  );
});
