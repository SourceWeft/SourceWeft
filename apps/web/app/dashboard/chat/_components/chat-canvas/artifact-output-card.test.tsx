// @vitest-environment jsdom

import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { test } from "vitest";
import "../artifact-render-host";
import { ArtifactOutputCard } from "./artifact-output-card";
import type { ArtifactStatusSnapshot, MessageRenderBlock } from "./types";

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
