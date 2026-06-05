import assert from "node:assert/strict";
import { test } from "vitest";
import {
  resolveArtifactDownloadUrl,
  resolveArtifactPageUrl,
  resolveArtifactProxyFileUrl,
} from "./artifacts";
import type { ArtifactListItem } from "./types";

function artifact(overrides: Partial<ArtifactListItem> = {}) {
  return {
    id: "artifact-1",
    artifactType: "image",
    status: "ready",
    storageKey: "artifacts/artifact-1/file.png",
    previewUrl: "/v1/workspaces/workspace-1/artifacts/artifact-1/file",
    title: "Generated image",
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    completedAt: new Date("2026-06-01T00:00:01.000Z"),
    promptText: null,
    errorMessage: null,
    payloadJson: null,
    capabilities: {
      canDownloadFile: true,
      canOpenFile: true,
      canPreviewInline: true,
      canRenderClientVideo: false,
    },
    ...overrides,
  } as ArtifactListItem;
}

test("resolveArtifactPageUrl returns the artifact preview page for open buttons", () => {
  assert.equal(
    resolveArtifactPageUrl({
      artifact: artifact(),
      workspaceId: "workspace-1",
    }),
    "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
  );
});

test("resolveArtifactProxyFileUrl returns the file proxy for thumbnails and media", () => {
  assert.equal(
    resolveArtifactProxyFileUrl({
      artifact: artifact(),
      workspaceId: "workspace-1",
    }),
    "/api/artifact-file?artifactId=artifact-1&workspaceId=workspace-1",
  );
});

test("resolveArtifactDownloadUrl returns a download-mode file proxy URL", () => {
  assert.equal(
    resolveArtifactDownloadUrl({
      artifact: artifact(),
      workspaceId: "workspace-1",
    }),
    "/api/artifact-file?artifactId=artifact-1&workspaceId=workspace-1&download=1",
  );
});

test("artifact URL helpers return null when there is no artifact file", () => {
  const pending = artifact({
    previewUrl: null,
    storageKey: null,
    capabilities: {
      canDownloadFile: false,
      canOpenFile: false,
      canPreviewInline: false,
      canRenderClientVideo: false,
    },
  });

  assert.equal(resolveArtifactPageUrl({ artifact: pending }), null);
  assert.equal(resolveArtifactProxyFileUrl({ artifact: pending }), null);
  assert.equal(resolveArtifactDownloadUrl({ artifact: pending }), null);
});

test("artifact URL helpers respect file capabilities", () => {
  const videoProject = artifact({
    artifactType: "video_presentation",
    previewUrl: "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
    storageKey: null,
    capabilities: {
      canDownloadFile: false,
      canOpenFile: false,
      canPreviewInline: true,
      canRenderClientVideo: true,
    },
  });

  assert.equal(
    resolveArtifactPageUrl({ artifact: videoProject, workspaceId: "workspace-1" }),
    "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
  );
  assert.equal(resolveArtifactDownloadUrl({ artifact: videoProject }), null);
});
