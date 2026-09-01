import assert from "node:assert/strict";
import { test } from "vitest";
import type {
  ToolCallRecord,
  TracePartRecord,
} from "../../_components/chat-canvas";
import {
  excludeResolvedToolConfirmationCalls,
  resolveReasoningTraceEventsFromMetadata,
  resolveTracePartToolConfirmations,
  resolveTracePartsFromMetadata,
  resolveThinkingStepsFromMetadata,
  resolveToolConfirmationCalls,
} from "./message-normalizers";

function confirmationToolCall(id: string): ToolCallRecord {
  return {
    id: `tool-${id}`,
    tool: "delete_notion_page",
    input: {},
    output: {
      type: "tool_confirmation_request",
      schemaVersion: 1,
      id,
      domain: "connector",
      subject: {
        label: "Lei Qin",
        provider: "notion",
        connectorId: "connector-1",
      },
      action: {
        type: "notion.page.trash",
        toolName: "delete_notion_page",
        label: "Trash",
        riskLevel: "high",
        status: "proposed",
        requiresApproval: true,
      },
      preview: {
        title: `Trash ${id}`,
      },
      decisionOptions: [
        { decision: "reject", label: "Reject" },
        { decision: "approve", label: "Approve" },
      ],
      execution: {
        providerStatus: "not_executed",
        executor: {
          kind: "connector_action_run",
          connectorId: "connector-1",
          actionRunId: id,
        },
      },
      status: "proposed",
      userMessage: "Waiting for confirmation.",
    },
    latencyMs: 0,
    status: "approval_requested",
    error: null,
  };
}

test("approval continuations do not carry resolved pending confirmations into the next assistant version", () => {
  const carried = excludeResolvedToolConfirmationCalls(
    [
      confirmationToolCall("approved-action"),
      confirmationToolCall("new-action"),
      {
        id: "tool-result",
        tool: "read_notion_page",
        input: {},
        output: { ok: true },
        latencyMs: 1,
        status: "completed",
        error: null,
      },
    ],
    ["approved-action"],
  );

  assert.deepEqual(
    carried.map((toolCall) => toolCall.id),
    ["tool-new-action", "tool-result"],
  );
});

test("approval continuations mark resolved trace parts terminal", () => {
  const toolCall = confirmationToolCall("rejected-action");
  const traceParts: TracePartRecord[] = [
    {
      id: "tool-rejected-action",
      kind: "tool",
      order: 0,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      toolCallId: toolCall.id,
      tool: toolCall.tool,
      status: "approval_requested",
      input: toolCall.input,
      output: toolCall.output,
      error: null,
      latencyMs: 0,
    },
  ];
  const resume = {
    decisions: [
      { type: "reject" as const, message: "Rejected in SourceWeft." },
    ],
  };

  const [resolvedToolCall] = resolveToolConfirmationCalls(
    [toolCall],
    ["rejected-action"],
    resume,
  );
  const [resolvedPart] = resolveTracePartToolConfirmations(
    traceParts,
    ["rejected-action"],
    resume,
  );

  assert.equal(resolvedToolCall?.status, "completed");
  assert.equal(resolvedToolCall?.approvalState, "rejected");
  assert.equal(resolvedToolCall?.approvalConfirmationId, "rejected-action");
  assert.equal(
    (resolvedToolCall?.output as { status?: string } | undefined)?.status,
    "rejected",
  );
  assert.equal(resolvedPart?.kind, "tool");
  assert.equal(
    resolvedPart?.kind === "tool" ? resolvedPart.status : null,
    "completed",
  );
  assert.equal(
    resolvedPart?.kind === "tool" ? resolvedPart.approvalState : null,
    "rejected",
  );
  assert.equal(
    resolvedPart?.kind === "tool" ? resolvedPart.approvalConfirmationId : null,
    "rejected-action",
  );
  assert.equal(
    resolvedPart?.kind === "tool"
      ? (resolvedPart.output as { status?: string } | undefined)?.status
      : null,
    "rejected",
  );
});

test("terminal messages normalize stale running thinking steps", () => {
  const metadata = {
    finishReason: "command_success_criteria_failed",
    threadRun: {
      status: "failed",
    },
    thinkingSteps: [
      {
        id: "command-retry",
        title: "Retrying command",
        status: "in_progress",
        items: [],
      },
    ],
    traceEvents: [
      {
        type: "thinking-step",
        id: "step-event-1",
        step: {
          id: "command-retry",
          title: "Retrying command",
          status: "in_progress",
          items: [],
        },
      },
    ],
    traceParts: [
      {
        id: "command-retry",
        kind: "step",
        order: 0,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        title: "Retrying command",
        status: "in_progress",
        items: [],
      },
    ],
  };

  assert.equal(
    resolveThinkingStepsFromMetadata(metadata)[0]?.status,
    "completed",
  );
  const traceEvent = resolveReasoningTraceEventsFromMetadata(metadata)[0];
  assert.equal(
    traceEvent?.type === "thinking-step" ? traceEvent.step.status : null,
    "completed",
  );
  const tracePart = resolveTracePartsFromMetadata(metadata)[0];
  assert.equal(
    tracePart?.kind === "step" ? tracePart.status : null,
    "completed",
  );
});
