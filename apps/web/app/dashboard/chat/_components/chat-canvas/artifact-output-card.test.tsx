// @vitest-environment jsdom

import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, test, vi } from "vitest";
import "../artifact-render-host";
import type { ArtifactStatusSnapshot, MessageRenderBlock } from "./types";

const getArtifactMock = vi.hoisted(() => vi.fn());

vi.mock("../../../../../lib/sdk", () => ({
  contentClient: { getArtifact: getArtifactMock },
}));

import { ArtifactOutputCard } from "./artifact-output-card";

beforeEach(() => {
  getArtifactMock.mockReset();
});

test("renders a committed sub-agent artifact without generation motion", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
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

  await act(async () => {
    root.render(
      createElement(ArtifactOutputCard, {
        artifactStatuses: new Map([[snapshot.id, snapshot]]),
        block,
        workspaceId: snapshot.workspaceId,
      }),
    );
  });

  assert.match(container.textContent ?? "", /Demo deck/);
  assert.match(container.textContent ?? "", /general-purpose/);
  assert.equal(container.querySelectorAll(".animate-spin").length, 0);

  await act(async () => root.unmount());
  container.remove();
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

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      createElement(ArtifactOutputCard, {
        artifactStatuses: new Map([
          [staleRunningSnapshot.id, staleRunningSnapshot],
        ]),
        block,
        workspaceId: staleRunningSnapshot.workspaceId,
      }),
    );
  });
  // Let the corrective fetch's promise resolve and the resulting state update flush.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  assert.equal(getArtifactMock.mock.calls.length, 1);
  assert.doesNotMatch(container.textContent ?? "", /unavailable/i);
  assert.match(container.textContent ?? "", /Refreshed deck/);

  await act(async () => root.unmount());
  container.remove();
});
