import assert from "node:assert/strict";
import { test } from "vitest";
import {
  artifactMatchesQuery,
  artifactPreviewImageMetadata,
  resolveArtifactDownloadUrl,
  resolveArtifactPageUrl,
  resolveArtifactPreviewImageProxyUrl,
  resolveArtifactProxyFileUrl,
} from "./artifacts";
import type { ArtifactListItem, ArtifactSummaryItem } from "./types";

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
      canRenderClientSide: false,
    },
    ...overrides,
  } as ArtifactListItem;
}

function artifactSummary(
  overrides: Partial<ArtifactSummaryItem> = {},
): ArtifactSummaryItem {
  return {
    id: "artifact-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    artifactType: "image",
    status: "ready",
    title: "Generated image",
    promptExcerpt: "A cat in a sunbeam",
    visibility: "private",
    isPublic: false,
    createdAt: "2026-06-01T00:00:00.000Z",
    completedAt: "2026-06-01T00:00:01.000Z",
    updatedAt: "2026-06-01T00:00:01.000Z",
    hasPrimaryFile: true,
    primaryFileUrl:
      "/v1/workspaces/workspace-1/artifacts/artifact-1/file",
    previewImage: null,
    ...overrides,
  };
}

test("artifact summary search uses the bounded prompt excerpt", () => {
  assert.equal(artifactMatchesQuery(artifactSummary(), "sunbeam"), true);
  assert.equal(artifactMatchesQuery(artifactSummary(), "missing"), false);
  assert.equal(
    "promptText" in artifactSummary(),
    false,
    "gallery summaries must not regain the full prompt",
  );
});

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

test("resolveArtifactPreviewImageProxyUrl returns semantic preview image proxy", () => {
  const slides = artifact({
    artifactType: "slides",
    previewMetadataJson: {
      altText: "First slide",
      byteLength: 1234,
      fileName: "preview.jpg",
      mimeType: "image/jpeg",
    },
    previewStorageKey: "artifacts/workspace-1/artifact-1/preview.jpg",
  });

  assert.deepEqual(artifactPreviewImageMetadata(slides), {
    altText: "First slide",
    byteLength: 1234,
    fileName: "preview.jpg",
    mimeType: "image/jpeg",
    storageKey: "artifacts/workspace-1/artifact-1/preview.jpg",
  });
  assert.equal(
    resolveArtifactPreviewImageProxyUrl({
      artifact: slides,
      workspaceId: "workspace-1",
    }),
    "/api/artifact-file?artifactId=artifact-1&workspaceId=workspace-1&asset=previewImage",
  );
});

test("resolveArtifactPreviewImageProxyUrl returns null without preview image metadata", () => {
  assert.equal(
    resolveArtifactPreviewImageProxyUrl({
      artifact: artifact({ artifactType: "slides" }),
      workspaceId: "workspace-1",
    }),
    null,
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
      canRenderClientSide: false,
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
      canRenderClientSide: true,
    },
  });

  assert.equal(
    resolveArtifactPageUrl({ artifact: videoProject, workspaceId: "workspace-1" }),
    "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
  );
  assert.equal(resolveArtifactDownloadUrl({ artifact: videoProject }), null);
});
