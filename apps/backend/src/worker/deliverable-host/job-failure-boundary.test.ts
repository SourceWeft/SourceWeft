import assert from "node:assert/strict";
import { test } from "vitest";

import { handleDeliverableJobFailure } from "./job-failure-boundary";

function makeInput(
  overrides: Partial<Parameters<typeof handleDeliverableJobFailure>[0]> = {},
) {
  const calls: Array<Record<string, unknown>> = [];
  const input = {
    jobName: "fake-generate",
    attemptsMade: 1,
    maxAttempts: 1,
    data: {
      artifactId: "artifact-1",
      teamId: "team-1",
      workspaceId: "workspace-1",
    },
    error: new Error("job stalled more than allowable limit"),
    failureCodes: {
      "fake-generate": "FAKE_DELIVERABLE_FAILED",
    },
    markFailed: async (markInput: Record<string, unknown>) => {
      calls.push(markInput);
      return true;
    },
    ...overrides,
  };
  return { calls, input };
}

test("marks the artifact failed on the final attempt", async () => {
  const { calls, input } = makeInput();
  const outcome = await handleDeliverableJobFailure(input);
  assert.equal(outcome, "marked");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.artifactId, "artifact-1");
  assert.equal(calls[0]?.errorCode, "FAKE_DELIVERABLE_FAILED");
  assert.equal(calls[0]?.errorMessage, "job stalled more than allowable limit");
  assert.deepEqual(calls[0]?.expectedStatuses, ["pending", "running"]);
});

test("skips when retries remain", async () => {
  const { calls, input } = makeInput({ attemptsMade: 1, maxAttempts: 3 });
  assert.equal(await handleDeliverableJobFailure(input), "skipped");
  assert.equal(calls.length, 0);
});

test("skips payloads without an artifactId", async () => {
  const { calls, input } = makeInput({ data: { something: "else" } });
  assert.equal(await handleDeliverableJobFailure(input), "skipped");
  assert.equal(calls.length, 0);
});

test("falls back to the generic code for unknown job names", async () => {
  const { calls, input } = makeInput({ jobName: "unknown-job" });
  await handleDeliverableJobFailure(input);
  assert.equal(calls[0]?.errorCode, "DELIVERABLE_JOB_FAILED");
});

test("swallows markFailed errors", async () => {
  const { input } = makeInput({
    markFailed: async () => {
      throw new Error("db down");
    },
  });
  assert.equal(await handleDeliverableJobFailure(input), "skipped");
});
