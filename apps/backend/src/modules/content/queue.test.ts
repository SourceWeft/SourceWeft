import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deliverablesGetJob: vi.fn(),
  enqueueWithAudit: vi.fn(),
  jobsAdd: vi.fn(),
  jobsGetJob: vi.fn(),
}));

vi.mock("../../shared/config", () => ({
  config: {
    deliverablesQueueName: "test-deliverables",
  },
}));

vi.mock("../../shared/queue", () => ({
  deliverablesQueue: {
    getJob: mocks.deliverablesGetJob,
  },
  enqueueWithAudit: mocks.enqueueWithAudit,
  jobsQueue: {
    add: mocks.jobsAdd,
    getJob: mocks.jobsGetJob,
  },
}));

import {
  enqueueVideoPresentationGenerateJob,
  VIDEO_PRESENTATION_GENERATE_JOB,
  DELIVERABLES_QUEUE_JOB_ATTEMPTS,
  type VideoPresentationGenerateJobPayload,
} from "./queue";

function payload(): VideoPresentationGenerateJobPayload {
  return {
    artifactId: "artifact-1",
    jobId: "video-presentation-render_artifact-1",
    narrationEnabled: true,
    request: { brief: "Explain the Feynman technique" },
    requestKey: "request-1",
    teamId: "team-1",
    threadId: "thread-1",
    title: "Feynman technique",
    userId: "user-1",
    userMessageId: "message-1",
    workspaceId: "workspace-1",
  };
}

beforeEach(() => {
  mocks.deliverablesGetJob.mockReset();
  mocks.enqueueWithAudit.mockReset();
  mocks.jobsAdd.mockReset();
  mocks.jobsGetJob.mockReset();
});

test("video presentation jobs use the dedicated deliverables queue", async () => {
  const queuedJob = { id: "video-presentation-render_artifact-1" };
  mocks.deliverablesGetJob.mockResolvedValue(null);
  mocks.enqueueWithAudit.mockResolvedValue(queuedJob);

  const result = await enqueueVideoPresentationGenerateJob(payload());

  assert.equal(result, queuedJob);
  assert.equal(mocks.jobsAdd.mock.calls.length, 0);
  assert.equal(mocks.enqueueWithAudit.mock.calls.length, 1);
  const [name, data, options, target] = mocks.enqueueWithAudit.mock.calls[0]!;
  assert.equal(name, VIDEO_PRESENTATION_GENERATE_JOB);
  assert.equal(data.artifactId, "artifact-1");
  assert.equal(options.attempts, DELIVERABLES_QUEUE_JOB_ATTEMPTS);
  assert.equal(options.backoff.type, "exponential");
  assert.equal(target.queueName, "test-deliverables");
});

test("a retained failed video job is retried without remove-and-add races", async () => {
  const retry = vi.fn().mockResolvedValue(undefined);
  const existing = {
    getState: vi.fn().mockResolvedValue("failed"),
    retry,
  };
  mocks.deliverablesGetJob.mockResolvedValue({
    ...existing,
  });

  const result = await enqueueVideoPresentationGenerateJob(payload());

  assert.equal(result.getState, existing.getState);
  assert.deepEqual(retry.mock.calls, [
    ["failed", { resetAttemptsMade: true, resetAttemptsStarted: true }],
  ]);
  assert.equal(mocks.enqueueWithAudit.mock.calls.length, 0);
});

test("an active video job is reused idempotently", async () => {
  const existing = {
    getState: vi.fn().mockResolvedValue("active"),
    retry: vi.fn(),
  };
  mocks.deliverablesGetJob.mockResolvedValue(existing);

  const result = await enqueueVideoPresentationGenerateJob(payload());

  assert.equal(result, existing);
  assert.equal(existing.retry.mock.calls.length, 0);
  assert.equal(mocks.enqueueWithAudit.mock.calls.length, 0);
});
