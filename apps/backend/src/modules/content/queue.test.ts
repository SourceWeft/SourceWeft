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
  enqueueDeliverableJob,
  DELIVERABLES_QUEUE_JOB_ATTEMPTS,
  type EnqueueDeliverableJobInput,
} from "./queue";

// A capability's job: the name comes from its manifest, and capability-private
// fields pass through the generic queue hop untouched.
const CAPABILITY_JOB_NAME = "fake-deliverable-generate";
const CAPABILITY_JOB_ID = "fake-deliverable_artifact-1";

function enqueueInput(): EnqueueDeliverableJobInput {
  return {
    jobName: CAPABILITY_JOB_NAME,
    jobId: CAPABILITY_JOB_ID,
    payload: {
      artifactId: "artifact-1",
      jobId: CAPABILITY_JOB_ID,
      layoutMode: "compact",
      request: { brief: "Write a concise report" },
      requestKey: "request-1",
      teamId: "team-1",
      threadId: "thread-1",
      title: "Feynman technique",
      userId: "user-1",
      userMessageId: "message-1",
      workspaceId: "workspace-1",
    },
  };
}

beforeEach(() => {
  mocks.deliverablesGetJob.mockReset();
  mocks.enqueueWithAudit.mockReset();
  mocks.jobsAdd.mockReset();
  mocks.jobsGetJob.mockReset();
});

test("deliverable jobs use the dedicated deliverables queue under the capability's job name", async () => {
  const queuedJob = { id: CAPABILITY_JOB_ID };
  mocks.deliverablesGetJob.mockResolvedValue(null);
  mocks.enqueueWithAudit.mockResolvedValue(queuedJob);

  const result = await enqueueDeliverableJob(enqueueInput());

  assert.equal(result, queuedJob);
  assert.equal(mocks.jobsAdd.mock.calls.length, 0);
  assert.equal(mocks.enqueueWithAudit.mock.calls.length, 1);
  const [name, data, options, target] = mocks.enqueueWithAudit.mock.calls[0]!;
  assert.equal(name, CAPABILITY_JOB_NAME);
  assert.equal(data.artifactId, "artifact-1");
  // Capability-private fields survive the generic hop verbatim.
  assert.equal(data.requestKey, "request-1");
  assert.equal(data.layoutMode, "compact");
  assert.equal(options.jobId, CAPABILITY_JOB_ID);
  assert.equal(options.attempts, DELIVERABLES_QUEUE_JOB_ATTEMPTS);
  assert.equal(options.backoff.type, "exponential");
  assert.equal(target.queueName, "test-deliverables");
});

test("a retained failed deliverable job is retried without remove-and-add races", async () => {
  const retry = vi.fn().mockResolvedValue(undefined);
  const existing = {
    getState: vi.fn().mockResolvedValue("failed"),
    retry,
  };
  mocks.deliverablesGetJob.mockResolvedValue({
    ...existing,
  });

  const result = await enqueueDeliverableJob(enqueueInput());

  assert.equal(result.getState, existing.getState);
  assert.deepEqual(retry.mock.calls, [
    ["failed", { resetAttemptsMade: true, resetAttemptsStarted: true }],
  ]);
  assert.equal(mocks.enqueueWithAudit.mock.calls.length, 0);
});

test("an active deliverable job is reused idempotently", async () => {
  const existing = {
    getState: vi.fn().mockResolvedValue("active"),
    retry: vi.fn(),
  };
  mocks.deliverablesGetJob.mockResolvedValue(existing);

  const result = await enqueueDeliverableJob(enqueueInput());

  assert.equal(result, existing);
  assert.equal(existing.retry.mock.calls.length, 0);
  assert.equal(mocks.enqueueWithAudit.mock.calls.length, 0);
});
