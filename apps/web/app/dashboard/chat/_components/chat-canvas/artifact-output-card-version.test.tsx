// @vitest-environment jsdom

import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { test, vi } from "vitest";
import type { ArtifactStatusSnapshot, MessageRenderBlock } from "./types";

const getArtifactVersionMedia = vi.hoisted(() => vi.fn());
const getArtifact = vi.hoisted(() => vi.fn());

vi.mock("../../../../../lib/sdk", () => ({
  contentClient: {
    getArtifact,
    getArtifactVersionMedia,
  },
}));

import "../artifact-render-host";
import { ArtifactOutputCard } from "./artifact-output-card";

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
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      createElement(ArtifactOutputCard, {
        artifactStatuses: new Map([["artifact-1", currentSnapshot()]]),
        block,
        onArtifactPreview,
        workspaceId: "workspace-1",
      }),
    );
    await Promise.resolve();
  });

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
  await act(async () => open.click());
  const record = onArtifactPreview.mock.calls[0]?.[0] as {
    payloadJson?: Record<string, unknown>;
  };
  const serialized = JSON.stringify(record.payloadJson);
  assert.doesNotMatch(serialized, /storageKey|sceneModules|VideoScene/u);
  assert.match(serialized, /artifactVersionId/u);

  await act(async () => root.unmount());
  container.remove();
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
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      createElement(ArtifactOutputCard, {
        block,
        workspaceId: "workspace-1",
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
  });

  assert.match(container.textContent ?? "", /Recorded version/u);
  assert.deepEqual(getArtifactVersionMedia.mock.calls.at(-1), [
    "workspace-1",
    "artifact-1",
    "version-1",
  ]);

  await act(async () => root.unmount());
  container.remove();
});
