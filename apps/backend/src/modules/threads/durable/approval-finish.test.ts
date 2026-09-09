import assert from "node:assert/strict";
import { test } from "vitest";
import { approvalFinishPayload } from "./approval-finish";
test("a durable approval finish preserves reason, IDs and the pending confirmation", () => {
  const confirmation = {
    type: "tool_confirmation_request",
    schemaVersion: 1,
    id: "confirm",
    domain: "sandbox",
    subject: { label: "Mac", provider: "sandbox" },
    action: {
      type: "execute",
      toolName: "execute",
      label: "Execute",
      riskLevel: "high",
      status: "proposed",
      requiresApproval: true,
    },
    preview: {
      title: "Review",
      requestJson: { command: "pwd", cwd: "/Users/test/tasks" },
    },
    decisionOptions: [{ decision: "approve", label: "Approve" }],
    execution: {
      providerStatus: "not_executed",
      executor: { kind: "sandbox_tool_call" },
    },
    status: "proposed",
    userMessage: "Review command",
  };
  const call = {
    id: "confirm",
    tool: "execute",
    input: { command: "pwd" },
    output: confirmation,
    status: "approval_requested",
  };
  const event = approvalFinishPayload({
    snapshot: {
      finishReason: "tool_confirmation_requested",
      toolCalls: [call],
    },
    assistantMessageId: "assistant-1",
    userMessageId: "user-1",
  });
  assert.equal(event.finishReason, "tool_confirmation_requested");
  assert.equal(event.messageId, "assistant-1");
  assert.equal(event.liveConfirmations.length, 1);
  assert.deepEqual(event.liveConfirmations[0]?.toolCall, call);
});
test("question pauses retain their reason and do not invent confirmations", () => {
  const event = approvalFinishPayload({
    snapshot: { finishReason: "user_question_requested" },
    assistantMessageId: "a",
  });
  assert.equal(event.finishReason, "user_question_requested");
  assert.deepEqual(event.liveConfirmations, []);
});
