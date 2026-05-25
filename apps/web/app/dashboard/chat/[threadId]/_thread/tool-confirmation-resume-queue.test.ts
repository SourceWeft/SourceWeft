import assert from "node:assert/strict";
import { test } from "vitest";
import {
  buildToolConfirmationResumeStreamInput,
  flushPendingToolConfirmationResume,
  resolveToolConfirmationResumeRequest,
  type ToolConfirmationResumeRequest,
} from "./tool-confirmation-resume-queue";

function resumeRequest(
  id: string,
  decision: "approve" | "reject" = "approve",
): ToolConfirmationResumeRequest {
  return {
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
  });

  assert.equal(next.pending, null);
  assert.equal(next.runnable, request);
  if (!next.runnable) {
    throw new Error("Expected resume request to be runnable.");
  }
  assert.deepEqual(buildToolConfirmationResumeStreamInput(next.runnable), {
    mode: "resume",
    assistantMessageId: "assistant-idle",
    attachOnly: true,
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
  });

  assert.equal(next.pending, request);
  assert.equal(next.runnable, null);
});

test("queued tool confirmation resume flushes once after streaming stops", () => {
  const request = resumeRequest("flush");
  const first = flushPendingToolConfirmationResume({
    isStreaming: false,
    pending: request,
  });
  const second = flushPendingToolConfirmationResume({
    isStreaming: false,
    pending: first.pending,
  });

  assert.equal(first.pending, null);
  assert.equal(first.runnable, request);
  assert.equal(second.pending, null);
  assert.equal(second.runnable, null);
});

test("approve and reject resumes share the same queue behavior", () => {
  for (const decision of ["approve", "reject"] as const) {
    const request = resumeRequest(decision, decision);
    const queued = resolveToolConfirmationResumeRequest({
      isStreaming: true,
      request,
    });
    const flushed = flushPendingToolConfirmationResume({
      isStreaming: false,
      pending: queued.pending,
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
