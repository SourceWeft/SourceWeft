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
 * Edit runs deliberately republish an artifact that is already `ready`, so
 * status cannot distinguish a legitimate edit from a duplicate edit — both see
 * `ready`. That is what `expectedVersionNo` is for: the run republishes onto
 * exactly the version it read when it loaded the payload, or it loses. The
 * status guard stays on top of it, widened to include `ready`, because no
 * version check would stop an edit republishing onto a `failed` artifact (a
 * failure leaves the version pointer alone).
 */

type MarkReadyCall = {
  expectedStatuses?: readonly string[];
  expectedVersionNo?: number;
};

function buildProcessor(input: {
  markReadyResult: { artifactId: string; versionId: string } | null;
  mode?: "create" | "edit";
  /** The artifact's published version at the moment the run loads it. */
  currentVersionNo?: number;
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
      find: async () => ({
        payloadJson: {},
        ...(input.currentVersionNo === undefined
          ? {}
          : { currentVersionNo: input.currentVersionNo }),
      }),
      markFailed: async () => {
        input.calls.markFailed += 1;
        return true;
      },
      markReady: async (markInput: MarkReadyCall) => {
        input.calls.markReady.push({
          expectedStatuses: markInput.expectedStatuses,
          ...("expectedVersionNo" in markInput
            ? { expectedVersionNo: markInput.expectedVersionNo }
            : {}),
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

test("edit runs widen the status guard to include ready instead of dropping it", async () => {
  const calls = { markReady: [] as MarkReadyCall[], markFailed: 0 };
  const processor = buildProcessor({
    markReadyResult: { artifactId: "artifact-1", versionId: "version-2" },
    mode: "edit",
    currentVersionNo: 3,
    calls,
  });

  await processor(JOB);

  // `failed` is deliberately absent: an edit must not republish an artifact
  // that a failure already terminated.
  assert.deepEqual(calls.markReady[0]?.expectedStatuses, [
    "ready",
    "running",
    "pending",
  ]);
});

test("an edit locks on the version it loaded, so a second edit cannot win twice", async () => {
  const calls = { markReady: [] as MarkReadyCall[], markFailed: 0 };
  const processor = buildProcessor({
    markReadyResult: { artifactId: "artifact-1", versionId: "version-4" },
    mode: "edit",
    currentVersionNo: 3,
    calls,
  });

  await processor(JOB);

  // Read at load time, carried to the publish minutes later: whatever the row
  // says then, this run only publishes if version 3 is still the published one.
  assert.equal(calls.markReady[0]?.expectedVersionNo, 3);
});

test("the second of two concurrent edits is superseded rather than colliding", async () => {
  const calls = { markReady: [] as MarkReadyCall[], markFailed: 0 };
  // Both runs loaded version 3; the other one published version 4 first, so
  // this CAS matches nothing.
  const processor = buildProcessor({
    markReadyResult: null,
    mode: "edit",
    currentVersionNo: 3,
    calls,
  });

  const result = (await processor(JOB)) as { status: string };

  assert.equal(result.status, "superseded");
  // The loser must not damage the winner's artifact, and must not die on the
  // artifact_versions unique index — the failure mode the version lock removes.
  assert.equal(calls.markFailed, 0);
});

test("create runs carry no version lock", async () => {
  const calls = { markReady: [] as MarkReadyCall[], markFailed: 0 };
  const processor = buildProcessor({
    markReadyResult: { artifactId: "artifact-1", versionId: "version-1" },
    currentVersionNo: 0,
    calls,
  });

  await processor(JOB);

  // A create run has no base version to lock against; the status guard already
  // means "nobody else has finished this".
  assert.equal("expectedVersionNo" in (calls.markReady[0] ?? {}), false);
});
