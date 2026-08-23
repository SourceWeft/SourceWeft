import assert from "node:assert/strict";
import test from "node:test";
import {
  artifactSummarySchema,
  listArtifactSummariesResponseSchema,
} from "../src/artifacts";

function summary(overrides: Record<string, unknown> = {}) {
  return {
    id: "artifact-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    artifactType: "video_presentation",
    status: "ready",
    title: "Quarterly review",
    promptExcerpt: "Summarize the quarter.",
    visibility: "private",
    isPublic: false,
    createdAt: "2026-08-23T01:00:00.000Z",
    completedAt: "2026-08-23T01:01:00.000Z",
    updatedAt: "2026-08-23T01:01:00.000Z",
    hasPrimaryFile: false,
    primaryFileUrl: null,
    previewImage: {
      url: "/v1/workspaces/workspace-1/artifacts/artifact-1/preview-image",
      altText: "Quarterly review cover",
    },
    ...overrides,
  };
}

test("artifact summary accepts the bounded gallery projection", () => {
  assert.deepEqual(artifactSummarySchema.parse(summary()), summary());
});

test("artifact summary strips detail-only and raw storage fields", () => {
  const parsed = artifactSummarySchema.parse(
    summary({
      payloadJson: { sourceJson: "large private body" },
      promptText: "unbounded prompt",
      storageBucket: "private-bucket",
      storageKey: "private/key",
      previewStorageKey: "private/preview.jpg",
      previewMetadataJson: { internal: true },
      errorCode: "INTERNAL",
      errorMessage: "internal error",
      capabilities: { canRenderClientSide: true },
    }),
  ) as Record<string, unknown>;

  for (const key of [
    "payloadJson",
    "promptText",
    "storageBucket",
    "storageKey",
    "previewStorageKey",
    "previewMetadataJson",
    "errorCode",
    "errorMessage",
    "capabilities",
  ]) {
    assert.equal(key in parsed, false, `${key} must not enter a summary`);
  }
});

test("artifact summary enforces the prompt excerpt bound", () => {
  assert.throws(() =>
    artifactSummarySchema.parse(summary({ promptExcerpt: "x".repeat(301) })),
  );
});

test("artifact summary list carries the pagination cursor", () => {
  const parsed = listArtifactSummariesResponseSchema.parse({
    items: [summary()],
    nextCursor: "cursor-2",
  });

  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.nextCursor, "cursor-2");
});
