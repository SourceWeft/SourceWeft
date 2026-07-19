import assert from "node:assert/strict";
import { test } from "vitest";
import type { Job } from "bullmq";

import { createDeliverableProcessor } from "./host";
import type { DeliverableStateLike } from "./stage-runner";

/**
 * markArtifactReady compare-and-swaps on status, so a duplicate delivery of an
 * already-published artifact loses the race and resolves null instead of
 * racing to insert the same versionNo (which the unique index
 * artifact_versions_artifact_version_uq would reject with an opaque
 * constraint violation).
 *
 * Edit runs are exempt: they deliberately republish an artifact that is
 * already `ready`, so status cannot distinguish a legitimate edit from a
 * duplicate. Guarding those needs version-based locking.
 */

type MarkReadyCall = {
  expectedStatuses?: readonly string[];
};

function buildProcessor(input: {
  markReadyResult: { artifactId: string; versionId: string } | null;
  mode?: "create" | "edit";
  calls: { markReady: MarkReadyCall[]; markFailed: number };
}) {
  const definition = {
    id: "fake_pipeline",
    jobName: "fake-generate",
    artifactType: "fake",
    stages: [{ id: "one", label: "One", budgetMs: 1000, maxAttempts: 1 }],
    defaultErrorCode: "FAKE_FAILED",
    invalidPayloadErrorCode: "FAKE_INVALID",
    prepareJob: () => ({}),
    loadState: () => ({
      generation: { status: "pending", stage: "one", progress: 0 },
    }),
    ...(input.mode === "edit"
      ? {
          prepareRun: ({ state }: { state: DeliverableStateLike }) => ({
            state,
            mode: "edit" as const,
          }),
        }
      : {}),
    buildStageView: () => ({}),
    runStage: async ({ state }: { state: DeliverableStateLike }) => state,
    finalize: () => ({ done: true }),
  } as never;

  const resolveRuntime = (async () => ({
    ctx: {} as never,
    artifacts: {
      find: async () => ({ payloadJson: {} }),
      markFailed: async () => {
        input.calls.markFailed += 1;
        return true;
      },
      markReady: async (markInput: MarkReadyCall) => {
        input.calls.markReady.push({
          expectedStatuses: markInput.expectedStatuses,
        });
        return input.markReadyResult;
      },
      markRunning: async () => true,
    },
  })) as never;

  return createDeliverableProcessor(definition, resolveRuntime);
}

const JOB = {
  data: {
    artifactId: "artifact-1",
    jobId: "job-1",
    teamId: "team-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    userId: "user-1",
    userMessageId: "message-1",
    request: {},
  },
} as unknown as Job<Record<string, unknown>>;

test("create run passes the status guard and publishes normally", async () => {
  const calls = { markReady: [] as MarkReadyCall[], markFailed: 0 };
  const processor = buildProcessor({
    markReadyResult: { artifactId: "artifact-1", versionId: "version-1" },
    calls,
  });

  const result = (await processor(JOB)) as { status: string; versionId: string };

  assert.equal(result.status, "ready");
  assert.equal(result.versionId, "version-1");
  assert.deepEqual(calls.markReady[0]?.expectedStatuses, [
    "pending",
    "running",
  ]);
});

test("losing the publish race reports superseded without failing the artifact", async () => {
  const calls = { markReady: [] as MarkReadyCall[], markFailed: 0 };
  const processor = buildProcessor({ markReadyResult: null, calls });

  const result = (await processor(JOB)) as { status: string };

  assert.equal(result.status, "superseded");
  // The winner's artifact must survive: no failure marking, no throw.
  assert.equal(calls.markFailed, 0);
});

test("edit runs omit the status guard because they republish a ready artifact", async () => {
  const calls = { markReady: [] as MarkReadyCall[], markFailed: 0 };
  const processor = buildProcessor({
    markReadyResult: { artifactId: "artifact-1", versionId: "version-2" },
    mode: "edit",
    calls,
  });

  await processor(JOB);

  assert.equal(calls.markReady[0]?.expectedStatuses, undefined);
});
