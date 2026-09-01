import { describe, expect, it } from "vitest";
import type { ArtifactPreviewContext } from "./types";
import { resolveArtifactPreviewRenderer } from "./preview-registry";

function context(
  artifact: Partial<ArtifactPreviewContext["artifact"]>,
  payload: Record<string, unknown> = {},
): ArtifactPreviewContext {
  return {
    artifact: {
      artifactType: "file",
      capabilities: {},
      completedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      createdBy: "user-1",
      errorCode: null,
      errorMessage: null,
      id: "artifact-1",
      payloadJson: payload,
      previewMetadataJson: {},
      previewStorageKey: null,
      promptText: null,
      status: "ready",
      storageBucket: null,
      storageKey: "artifact.bin",
      teamId: "team-1",
      threadId: "thread-1",
      title: "Artifact",
      updatedAt: "2026-01-01T00:00:00.000Z",
      workspaceId: "workspace-1",
      ...artifact,
    } as ArtifactPreviewContext["artifact"],
    downloadUrl: "/download",
    layout: "panel",
    pageUrl: "/page",
    payload,
    proxyFileUrl: "/file",
    title: "Artifact",
    workspaceId: "workspace-1",
  };
}

describe("resolveArtifactPreviewRenderer", () => {
  it("selects feature adapters by artifact capability/type", () => {
    expect(
      resolveArtifactPreviewRenderer(context({ artifactType: "image" }))?.id,
    ).toBe("image");
    expect(
      resolveArtifactPreviewRenderer(
        context({ artifactType: "video_overview" }),
      )?.id,
    ).toBe("video-file");
    expect(
      resolveArtifactPreviewRenderer(context({ artifactType: "slides" }))?.id,
    ).toBe("slides-pptx");
    expect(
      resolveArtifactPreviewRenderer(
        context({ artifactType: "video_presentation", status: "pending" }),
      )?.id,
    ).toBe("video-presentation");
  });

  it("returns null for unsupported artifacts", () => {
    expect(
      resolveArtifactPreviewRenderer(context({ artifactType: "file" })),
    ).toBe(null);
  });
});
