// @vitest-environment jsdom

import assert from "node:assert/strict";
import { createElement } from "react";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import "../artifact-render-host";
import type { ArtifactStatusSnapshot, MessageRenderBlock } from "./types";

const getArtifactMock = vi.hoisted(() => vi.fn());
const getArtifactVersionMedia = vi.hoisted(() => vi.fn());

vi.mock("../../../../../lib/sdk", () => ({
  contentClient: {
    getArtifact: getArtifactMock,
    getArtifactVersionMedia,
  },
}));

import { ArtifactOutputCard } from "./artifact-output-card";
import { click, flush, mountWithIntl, unmountAll } from "@/test/react";

beforeEach(() => {
  getArtifactMock.mockReset();
});
afterEach(unmountAll);

test("renders a committed sub-agent artifact without generation motion", async () => {
  const snapshot: ArtifactStatusSnapshot = {
    artifactType: "slides",
    capabilities: {
      canDownloadFile: false,
      canOpenFile: true,
      canPreviewInline: true,
      canRenderClientSide: true,
    },
    completedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    createdBy: "user-1",
    errorCode: null,
    errorMessage: null,
    id: "artifact-1",
    payloadJson: {},
    previewMetadataJson: {},
    previewStorageKey: null,
    previewUrl: null,
    promptText: "A concise demo",
    storageBucket: null,
    storageKey: null,
    status: "ready",
    teamId: "team-1",
    threadId: "thread-1",
    title: "Demo deck",
    updatedAt: new Date().toISOString(),
    workspaceId: "workspace-1",
  };
  const block: Extract<MessageRenderBlock, { type: "artifact_output" }> = {
    artifactId: snapshot.id,
    artifactVersionId: "version-1",
    id: "artifact-output:run-1:artifact-1:version-1",
    placement: "terminal",
    producer: { kind: "subagent", subagentType: "general-purpose" },
    sequence: 1,
    sourceToolCallId: "publish-1",
    threadRunId: "run-1",
    type: "artifact_output",
  };

  const { container } = await mountWithIntl(
    createElement(ArtifactOutputCard, {
      artifactStatuses: new Map([[snapshot.id, snapshot]]),
      block,
      workspaceId: snapshot.workspaceId,
    }),
  );

  assert.match(container.textContent ?? "", /Demo deck/);
  assert.match(container.textContent ?? "", /general-purpose/);
  assert.equal(container.querySelectorAll(".animate-spin").length, 0);

  await unmountAll();
});

test("a stale non-terminal parent snapshot does not permanently block the card from refreshing to ready", async () => {
  // Simulates the once-only artifactStatuses fetch caching a "running" status
  // early in generation, with no later refresh once the tool call commits
  // (the artifactId simply drops out of the pending set at that point). This
  // card must still be able to self-correct once a committed artifact_output
  // block exists for it — the very fact this block rendered means the
  // artifact is already ready server-side.
  const staleRunningSnapshot: ArtifactStatusSnapshot = {
    artifactType: "slides",
    capabilities: {
      canDownloadFile: false,
      canOpenFile: false,
      canPreviewInline: false,
      canRenderClientSide: false,
    },
    completedAt: null,
    createdAt: new Date().toISOString(),
    createdBy: "user-1",
    errorCode: null,
    errorMessage: null,
    id: "artifact-2",
    payloadJson: {},
    previewMetadataJson: {},
    previewStorageKey: null,
    previewUrl: null,
    promptText: null,
    storageBucket: null,
    storageKey: null,
    status: "running",
    teamId: "team-1",
    threadId: "thread-1",
    title: null,
    updatedAt: new Date().toISOString(),
    workspaceId: "workspace-1",
  };
  getArtifactMock.mockResolvedValue({
    artifact: {
      ...staleRunningSnapshot,
      artifactVersionId: "version-1",
      status: "ready",
      title: "Refreshed deck",
      completedAt: new Date().toISOString(),
    },
  });
  const block: Extract<MessageRenderBlock, { type: "artifact_output" }> = {
    artifactId: staleRunningSnapshot.id,
    artifactVersionId: "version-1",
    id: "artifact-output:run-2:artifact-2:version-1",
    placement: "terminal",
    producer: { kind: "main" },
    sequence: 1,
    sourceToolCallId: "publish-2",
    threadRunId: "run-2",
    type: "artifact_output",
  };

  const { container } = await mountWithIntl(
    createElement(ArtifactOutputCard, {
      artifactStatuses: new Map([
        [staleRunningSnapshot.id, staleRunningSnapshot],
      ]),
      block,
      workspaceId: staleRunningSnapshot.workspaceId,
    }),
  );
  // Let the corrective fetch's promise resolve and the resulting state update flush.
  await flush(2);

  assert.equal(getArtifactMock.mock.calls.length, 1);
  assert.doesNotMatch(container.textContent ?? "", /unavailable/i);
  assert.match(container.textContent ?? "", /Refreshed deck/);

  await unmountAll();
});

describe("artifact-output-card-version.test.tsx", () => {
  const getArtifact = getArtifactMock;

  function currentSnapshot(): ArtifactStatusSnapshot {
    const now = "2026-08-31T00:00:00.000Z";
    return {
      artifactType: "video_presentation",
      capabilities: {
        canDownloadFile: true,
        canOpenFile: true,
        canPreviewInline: true,
        canRenderClientSide: true,
      },
      completedAt: now,
      createdAt: now,
      createdBy: "user-1",
      errorCode: null,
      errorMessage: null,
      id: "artifact-1",
      payloadJson: { project: { title: "Current version" } },
      previewMetadataJson: {},
      previewStorageKey: "current-cover.jpg",
      previewUrl: null,
      promptText: "Current prompt",
      storageBucket: "bucket",
      storageKey: null,
      status: "ready",
      teamId: "team-1",
      threadId: "thread-1",
      title: "Current version",
      updatedAt: now,
      workspaceId: "workspace-1",
    };
  }

  test("artifact-output card renders the recorded version and never the current payload", async () => {
    getArtifactVersionMedia.mockResolvedValueOnce({
      media: {
        artifactId: "artifact-1",
        artifactVersionId: "version-1",
        artifactType: "video_presentation",
        title: "Recorded version",
        description: "Recorded description",
        durationSeconds: 10,
        media: {
          url: "/v1/video",
          downloadUrl: "/v1/video?download=1",
          contentType: "video/mp4",
          fileName: "recorded.mp4",
          byteLength: 1024,
          width: 1920,
          height: 1080,
          fps: 30,
          hasAudio: true,
        },
        coverImage: {
          url: "/v1/cover",
          contentType: "image/jpeg",
          fileName: "cover.jpg",
          byteLength: 128,
          width: 1920,
          height: 1080,
        },
      },
    });
    const block: Extract<MessageRenderBlock, { type: "artifact_output" }> = {
      artifactId: "artifact-1",
      artifactVersionId: "version-1",
      id: "artifact-output:run-1:artifact-1:version-1",
      placement: "terminal",
      producer: { kind: "main" },
      sequence: 1,
      sourceToolCallId: "publish-1",
      threadRunId: "run-1",
      type: "artifact_output",
    };
    const onArtifactPreview = vi.fn();
    const { container } = await mountWithIntl(
      createElement(ArtifactOutputCard, {
        artifactStatuses: new Map([["artifact-1", currentSnapshot()]]),
        block,
        onArtifactPreview,
        workspaceId: "workspace-1",
      }),
    );
    await flush();

    assert.match(container.textContent ?? "", /Recorded version/u);
    assert.doesNotMatch(container.textContent ?? "", /Current version/u);
    assert.deepEqual(getArtifactVersionMedia.mock.calls[0], [
      "workspace-1",
      "artifact-1",
      "version-1",
    ]);

    const open = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Open"),
    );
    assert.ok(open);
    await click(open);
    const record = onArtifactPreview.mock.calls[0]?.[0] as {
      payloadJson?: Record<string, unknown>;
    };
    const serialized = JSON.stringify(record.payloadJson);
    assert.doesNotMatch(serialized, /storageKey|sceneModules|VideoScene/u);
    assert.match(serialized, /artifactVersionId/u);

    await unmountAll();
  });

  test("an invalid current version cannot block a valid recorded version", async () => {
    getArtifact.mockResolvedValueOnce({
      artifact: {
        ...currentSnapshot(),
        payloadJson: {},
        artifactVersionId: null,
      },
    });
    getArtifactVersionMedia.mockResolvedValueOnce({
      media: {
        artifactId: "artifact-1",
        artifactVersionId: "version-1",
        artifactType: "video_presentation",
        title: "Recorded version",
        description: null,
        durationSeconds: 10,
        media: {
          url: "/v1/video",
          downloadUrl: "/v1/video?download=1",
          contentType: "video/mp4",
          fileName: "recorded.mp4",
          byteLength: 1024,
        },
        coverImage: null,
      },
    });
    const block: Extract<MessageRenderBlock, { type: "artifact_output" }> = {
      artifactId: "artifact-1",
      artifactVersionId: "version-1",
      id: "artifact-output:run-1:artifact-1:version-1",
      placement: "terminal",
      producer: { kind: "main" },
      sequence: 1,
      sourceToolCallId: "publish-1",
      threadRunId: "run-1",
      type: "artifact_output",
    };
    const { container } = await mountWithIntl(
      createElement(ArtifactOutputCard, {
        block,
        workspaceId: "workspace-1",
      }),
    );
    await flush(2);

    assert.match(container.textContent ?? "", /Recorded version/u);
    assert.deepEqual(getArtifactVersionMedia.mock.calls.at(-1), [
      "workspace-1",
      "artifact-1",
      "version-1",
    ]);

    await unmountAll();
  });
});
