// @vitest-environment jsdom

import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { ArtifactStatusSnapshot } from "./types";

const getArtifactMock = vi.hoisted(() => vi.fn());

vi.mock("../../../../../lib/sdk", () => ({
  contentClient: { getArtifact: getArtifactMock },
}));

import { useArtifactSnapshot } from "./use-artifact-snapshot";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function snapshot(input: {
  id: string;
  workspaceId: string;
  status?: ArtifactStatusSnapshot["status"];
}): ArtifactStatusSnapshot {
  const now = "2026-08-25T00:00:00.000Z";
  return {
    artifactType: "video_presentation",
    capabilities: {
      canDownloadFile: false,
      canOpenFile: true,
      canPreviewInline: true,
      canRenderClientSide: true,
    },
    completedAt: input.status === "ready" ? now : null,
    createdAt: now,
    createdBy: "user-1",
    errorCode: null,
    errorMessage: null,
    id: input.id,
    payloadJson: {},
    previewMetadataJson: {},
    previewStorageKey: null,
    previewUrl: null,
    promptText: null,
    storageBucket: null,
    storageKey: null,
    status: input.status ?? "ready",
    teamId: "team-1",
    threadId: "thread-1",
    title: input.id,
    updatedAt: now,
    workspaceId: input.workspaceId,
  };
}

function Probe(props: {
  artifactSnapshot?: ArtifactStatusSnapshot;
  artifactId: string;
  workspaceId: string;
}) {
  const result = useArtifactSnapshot({
    artifactSnapshot: props.artifactSnapshot,
    enabled: true,
    toolCallOutput: { artifact_id: props.artifactId },
    workspaceId: props.workspaceId,
  });
  return createElement(
    "output",
    null,
    `${result.artifactId ?? "none"}|${result.snapshot?.id ?? "none"}|${result.error ?? ""}`,
  );
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  getArtifactMock.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
  }
  container?.remove();
  root = null;
  container = null;
});

test("changing artifact identity clears the old terminal snapshot before fetching", async () => {
  await act(async () => {
    root?.render(
      createElement(Probe, {
        artifactId: "artifact-1",
        artifactSnapshot: snapshot({
          id: "artifact-1",
          workspaceId: "workspace-1",
        }),
        workspaceId: "workspace-1",
      }),
    );
  });
  assert.match(container?.textContent ?? "", /artifact-1\|artifact-1/u);

  let resolveDetail!: (value: unknown) => void;
  getArtifactMock.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveDetail = resolve;
    }),
  );
  await act(async () => {
    root?.render(
      createElement(Probe, {
        artifactId: "artifact-2",
        workspaceId: "workspace-1",
      }),
    );
  });

  assert.equal(container?.textContent, "artifact-2|none|");
  assert.deepEqual(getArtifactMock.mock.calls[0]?.slice(0, 2), [
    "workspace-1",
    "artifact-2",
  ]);

  await act(async () => {
    resolveDetail({
      artifact: snapshot({ id: "artifact-2", workspaceId: "workspace-1" }),
    });
  });
  assert.equal(container?.textContent, "artifact-2|artifact-2|");
});

test("a mismatched artifact detail response is rejected", async () => {
  getArtifactMock.mockResolvedValueOnce({
    artifact: snapshot({ id: "artifact-other", workspaceId: "workspace-1" }),
  });

  await act(async () => {
    root?.render(
      createElement(Probe, {
        artifactId: "artifact-1",
        workspaceId: "workspace-1",
      }),
    );
  });

  assert.equal(
    container?.textContent,
    "artifact-1|none|Artifact details did not match the request.",
  );
});

test("a mismatched parent snapshot is rejected without suppressing the requested fetch", async () => {
  getArtifactMock.mockResolvedValueOnce({
    artifact: snapshot({ id: "artifact-1", workspaceId: "workspace-1" }),
  });

  await act(async () => {
    root?.render(
      createElement(Probe, {
        artifactId: "artifact-1",
        artifactSnapshot: snapshot({
          id: "artifact-other",
          workspaceId: "workspace-1",
        }),
        workspaceId: "workspace-1",
      }),
    );
  });

  assert.equal(container?.textContent, "artifact-1|artifact-1|");
  assert.equal(getArtifactMock.mock.calls.length, 1);
});
