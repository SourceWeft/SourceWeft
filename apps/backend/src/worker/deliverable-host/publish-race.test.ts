import assert from "node:assert/strict";
import { test } from "vitest";
import type { Job } from "bullmq";

import { createDeliverableProcessor } from "./host";
import type { DeliverableStateLike } from "./stage-runner";

/**
 * The completion compare-and-swaps on status, so a duplicate delivery of an
 * already-published artifact loses the race and resolves null instead of
 * racing to insert the same versionNo (which the unique index
 * artifact_versions_artifact_version_uq would reject with an opaque
 * constraint violation). The host publishes through `completeArtifact`, the
 * shared two-phase write path; the CAS arguments below are what it carries
 * there.
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
  artifactType?: string;
  title?: string;
  payload?: Record<string, unknown>;
  preview?: { storageKey: string; metadata: Record<string, unknown> };
  expectedStatuses?: readonly string[];
  expectedVersionNo?: number;
};

function buildProcessor(input: {
  markReadyResult: { artifactId: string; versionId: string } | null;
  mode?: "create" | "edit";
  /** The artifact's published version at the moment the run loads it. */
  currentVersionNo?: number;
  /** The title the row was opened with, as the artifact load reports it. */
  artifactTitle?: string;
  /** A thumbnail a stage declares through api.setPreviewImage. */
  previewImage?: { storageKey: string; metadata: Record<string, unknown> };
  calls: { markReady: MarkReadyCall[]; markFailed: number };
}) {
  const definition = {
    id: "fake_pipeline",
    jobName: "fake-generate",
    artifactType: "report",
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
    runStage: async ({
      state,
      api,
    }: {
      state: DeliverableStateLike;
      api: {
        setPreviewImage: (image: {
          storageKey: string;
          metadata: Record<string, unknown>;
        }) => void;
      };
    }) => {
      if (input.previewImage) {
        api.setPreviewImage(input.previewImage);
      }
      return state;
    },
    finalize: () => ({ done: true }),
  } as never;

  const resolveRuntime = (async () => ({
    ctx: {} as never,
    artifacts: {
      find: async () => ({
        payloadJson: {},
        ...(input.artifactTitle === undefined
          ? {}
          : { title: input.artifactTitle }),
        ...(input.currentVersionNo === undefined
          ? {}
          : { currentVersionNo: input.currentVersionNo }),
      }),
      markFailed: async () => {
        input.calls.markFailed += 1;
        return true;
      },
      completeArtifact: async (markInput: MarkReadyCall) => {
        input.calls.markReady.push({
          artifactType: markInput.artifactType,
          title: markInput.title,
          payload: markInput.payload,
          ...(markInput.preview ? { preview: markInput.preview } : {}),
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

test("the completion carries the pipeline's artifact type and finished payload", async () => {
  const calls = { markReady: [] as MarkReadyCall[], markFailed: 0 };
  const processor = buildProcessor({
    markReadyResult: { artifactId: "artifact-1", versionId: "version-1" },
    calls,
  });

  await processor(JOB);

  // The type is the pipeline's own declaration, not host knowledge, and the
  // payload is finalize()'s whole result — a completion republishes the entire
  // artifact, never a patch onto the previous version.
  assert.equal(calls.markReady[0]?.artifactType, "report");
  assert.deepEqual(calls.markReady[0]?.payload, { done: true });
});

test("a stage's thumbnail reaches the completion as the pointer it uploaded", async () => {
  const calls = { markReady: [] as MarkReadyCall[], markFailed: 0 };
  const processor = buildProcessor({
    markReadyResult: { artifactId: "artifact-1", versionId: "version-1" },
    previewImage: {
      storageKey: "workspace-1/artifact-1/cover.jpg",
      metadata: { fileName: "cover.jpg", mimeType: "image/jpeg" },
    },
    calls,
  });

  await processor(JOB);

  // The bytes were uploaded mid-run by the stage that rendered them, so what
  // survives to publish time is a key. Losing it here would silently drop every
  // pipeline's thumbnail.
  assert.deepEqual(calls.markReady[0]?.preview, {
    storageKey: "workspace-1/artifact-1/cover.jpg",
    metadata: { fileName: "cover.jpg", mimeType: "image/jpeg" },
  });
});

test("a run with no thumbnail keeps whatever the artifact already has", async () => {
  const calls = { markReady: [] as MarkReadyCall[], markFailed: 0 };
  const processor = buildProcessor({
    markReadyResult: { artifactId: "artifact-1", versionId: "version-1" },
    calls,
  });

  await processor(JOB);

  // Omitted, not null: null would be "clear the thumbnail", which is not what
  // "this run produced no still" means.
  assert.equal("preview" in (calls.markReady[0] ?? {}), false);
});

test("the completion reports a title even when the job envelope carries none", async () => {
  const calls = { markReady: [] as MarkReadyCall[], markFailed: 0 };
  const processor = buildProcessor({
    markReadyResult: { artifactId: "artifact-1", versionId: "version-1" },
    artifactTitle: "Feynman Method",
    calls,
  });

  await processor(JOB);

  // The write path requires every spec to name a title; the completion does not
  // write one, so the artifact's own title is the honest answer.
  assert.equal(calls.markReady[0]?.title, "Feynman Method");
});

test("a pipeline whose artifact has no title still publishes", async () => {
  const calls = { markReady: [] as MarkReadyCall[], markFailed: 0 };
  const processor = buildProcessor({
    markReadyResult: { artifactId: "artifact-1", versionId: "version-1" },
    calls,
  });

  const result = (await processor(JOB)) as { status: string };

  // A field nothing stores must never be the reason a finished render is lost.
  assert.equal(result.status, "ready");
  assert.equal(calls.markReady[0]?.title, "fake_pipeline");
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
