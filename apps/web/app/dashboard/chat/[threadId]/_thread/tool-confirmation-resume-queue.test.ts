import assert from "node:assert/strict";
import { test } from "vitest";
import {
  buildToolConfirmationResumeStreamInput,
  createToolConfirmationResumeQueueState,
  flushPendingToolConfirmationResume,
  getToolConfirmationResumeDurableRunKey,
  getToolConfirmationResumeRequestKey,
  resolveToolConfirmationResumeRequest,
  type ToolConfirmationResumeRequest,
} from "./tool-confirmation-resume-queue";

function resumeRequest(
  id: string,
  decision: "approve" | "reject" = "approve",
): ToolConfirmationResumeRequest {
  return {
    approvalThreadRunId: `run-${id}`,
    assistantMessageId: `assistant-${id}`,
    resolvedConfirmationIds: [`confirmation-${id}`],
    toolApprovalResume: {
      decisions:
        decision === "approve"
          ? [{ type: "approve" }]
          : [{ type: "reject", message: "Rejected in SourceWeft." }],
    },
  };
}

test("tool confirmation resume runs immediately when the stream is idle", () => {
  const request = resumeRequest("idle");
  const next = resolveToolConfirmationResumeRequest({
    isStreaming: false,
    request,
    state: createToolConfirmationResumeQueueState(),
  });

  assert.equal(next.state.pending, null);
  assert.equal(next.runnable, request);
  if (!next.runnable) {
    throw new Error("Expected resume request to be runnable.");
  }
  assert.deepEqual(buildToolConfirmationResumeStreamInput(next.runnable), {
    mode: "resume",
    assistantMessageId: "assistant-idle",
    attachOnly: true,
    durableRunKey: getToolConfirmationResumeDurableRunKey(request),
    resolvedConfirmationIds: ["confirmation-idle"],
    toolApprovalResume: {
      decisions: [{ type: "approve" }],
    },
  });
});

test("tool confirmation resume is queued while the previous stream is settling", () => {
  const request = resumeRequest("queued");
  const next = resolveToolConfirmationResumeRequest({
    isStreaming: true,
    request,
    state: createToolConfirmationResumeQueueState(),
  });

  assert.equal(next.state.pending, request);
  assert.equal(next.runnable, null);
});

test("queued tool confirmation resume flushes once after streaming stops", () => {
  const request = resumeRequest("flush");
  const queued = resolveToolConfirmationResumeRequest({
    isStreaming: true,
    request,
    state: createToolConfirmationResumeQueueState(),
  });
  const first = flushPendingToolConfirmationResume({
    isStreaming: false,
    state: queued.state,
  });
  const second = flushPendingToolConfirmationResume({
    isStreaming: false,
    state: first.state,
  });

  assert.equal(first.state.pending, null);
  assert.equal(first.runnable, request);
  assert.equal(second.state.pending, null);
  assert.equal(second.runnable, null);
});

test("duplicate queued tool confirmation resume is coalesced while streaming", () => {
  const request = resumeRequest("duplicate-pending");
  const first = resolveToolConfirmationResumeRequest({
    isStreaming: true,
    request,
    state: createToolConfirmationResumeQueueState(),
  });
  const second = resolveToolConfirmationResumeRequest({
    isStreaming: true,
    request,
    state: first.state,
  });

  assert.equal(first.state.pending, request);
  assert.equal(second.state.pending, request);
  assert.equal(second.runnable, null);
});

test("duplicate idle resume requests use the same durable run key", () => {
  const request = resumeRequest("duplicate-launched");
  const first = resolveToolConfirmationResumeRequest({
    isStreaming: false,
    request,
    state: createToolConfirmationResumeQueueState(),
  });
  const second = resolveToolConfirmationResumeRequest({
    isStreaming: false,
    request,
    state: first.state,
  });

  assert.equal(first.runnable, request);
  assert.equal(second.runnable, request);
  assert.deepEqual(
    buildToolConfirmationResumeStreamInput(first.runnable),
    buildToolConfirmationResumeStreamInput(second.runnable),
  );
});

test("distinct tool confirmation resume payload can launch separately", () => {
  const approveRequest = resumeRequest("distinct", "approve");
  const rejectRequest = resumeRequest("distinct", "reject");
  const first = resolveToolConfirmationResumeRequest({
    isStreaming: false,
    request: approveRequest,
    state: createToolConfirmationResumeQueueState(),
  });
  const second = resolveToolConfirmationResumeRequest({
    isStreaming: false,
    request: rejectRequest,
    state: first.state,
  });

  assert.equal(first.runnable, approveRequest);
  assert.equal(second.runnable, rejectRequest);
});

test("tool confirmation resume idempotency key is deterministic for equivalent payloads", () => {
  const firstRequest: ToolConfirmationResumeRequest = {
    approvalThreadRunId: "run-stable",
    assistantMessageId: "assistant-stable",
    resolvedConfirmationIds: ["confirmation-stable"],
    toolApprovalResume: {
      decisions: [{ type: "approve" }],
      sourceweft: {
        hitlInterruptId: "interrupt-1",
        sandboxExecuteToolCallId: "call-1",
      },
    },
  };
  const secondRequest: ToolConfirmationResumeRequest = {
    approvalThreadRunId: "run-stable",
    assistantMessageId: "assistant-stable",
    resolvedConfirmationIds: ["confirmation-stable"],
    toolApprovalResume: {
      sourceweft: {
        sandboxExecuteToolCallId: "call-1",
        hitlInterruptId: "interrupt-1",
      },
      decisions: [{ type: "approve" }],
    },
  };

  assert.equal(
    getToolConfirmationResumeRequestKey(firstRequest),
    getToolConfirmationResumeRequestKey(secondRequest),
  );
  assert.equal(
    getToolConfirmationResumeDurableRunKey(firstRequest),
    getToolConfirmationResumeDurableRunKey(secondRequest),
  );
  assert.equal(
    getToolConfirmationResumeDurableRunKey(firstRequest).startsWith(
      "sourceweft-web-run:resume:run-stable:assistant-stable:confirmation-stable:",
    ),
    true,
  );
  assert.equal(
    getToolConfirmationResumeDurableRunKey(firstRequest).length <= 256,
    true,
  );
});

test("approve and reject resumes share the same queue behavior", () => {
  for (const decision of ["approve", "reject"] as const) {
    const request = resumeRequest(decision, decision);
    const queued = resolveToolConfirmationResumeRequest({
      isStreaming: true,
      request,
      state: createToolConfirmationResumeQueueState(),
    });
    const flushed = flushPendingToolConfirmationResume({
      isStreaming: false,
      state: queued.state,
    });

    assert.equal(queued.runnable, null);
    assert.equal(flushed.runnable, request);
    if (!flushed.runnable) {
      throw new Error("Expected queued resume request to flush.");
    }
    assert.deepEqual(
      buildToolConfirmationResumeStreamInput(flushed.runnable).toolApprovalResume,
      request.toolApprovalResume,
    );
  }
});
