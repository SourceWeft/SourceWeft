import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { contentArtifactsService, testExports } from "./service";
import { createArtifactViewHandlerRegistry } from "./view-handlers";
import {
  createSyntheticFileArtifactViewHandler,
  createSyntheticTakeoverArtifactViewHandler,
  SYNTHETIC_FILE_ARTIFACT_TYPE,
  SYNTHETIC_FILE_EXTENSION,
  SYNTHETIC_TAKEOVER_ARTIFACT_TYPE,
} from "../../test/synthetic-capability";

const mocks = vi.hoisted(() => ({
  findPubliclySharedArtifactIds: vi.fn(),
  listArtifactSummaryRecords: vi.fn(),
  loadArtifactViewHandlerRegistry: vi.fn(),
  requireContentWorkspace: vi.fn(),
}));

/**
 * Driven by a synthetic capability, not a real one. Every assertion below is
 * about the host: whether it asks the handler before falling back, and what it
 * concludes when no handler claims the type. Binding a real capability here
 * made these tests fail whenever that capability changed a file extension.
 */
const handlers = createArtifactViewHandlerRegistry([
  createSyntheticFileArtifactViewHandler(),
  createSyntheticTakeoverArtifactViewHandler(),
]);

function handlerFor(artifactType: string) {
  return handlers.handlerFor(artifactType);
}

vi.mock("../workspace/guards", () => ({
  requireContentWorkspace: mocks.requireContentWorkspace,
}));

vi.mock("../sources/storage", () => ({
  downloadArtifactObject: vi.fn(),
}));

vi.mock("./repository", () => ({
  findArtifactRecord: vi.fn(),
  listArtifactRecords: vi.fn(),
  listArtifactSummaryRecords: mocks.listArtifactSummaryRecords,
}));

vi.mock("../sharing/store", () => ({
  findPubliclySharedArtifactIds: mocks.findPubliclySharedArtifactIds,
  revokeShareLink: vi.fn(),
}));

vi.mock("./view-handlers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./view-handlers")>()),
  loadArtifactViewHandlerRegistry: mocks.loadArtifactViewHandlerRegistry,
}));

test("artifact summaries are bounded and never load type handlers", async () => {
  vi.clearAllMocks();
  mocks.requireContentWorkspace.mockResolvedValue({
    id: "workspace-1",
    organizationId: "team-1",
  });
  const items = Array.from({ length: 100 }, (_, index) => ({
    id: `artifact-${index}`,
    workspaceId: "workspace-1",
    threadId: "thread-1",
    artifactType: "video_presentation" as const,
    status: "ready" as const,
    title: `Artifact ${index}`,
    promptExcerpt: "p".repeat(300),
    visibility: "private" as const,
    createdAt: "2026-08-23T01:00:00.000Z",
    completedAt: "2026-08-23T01:01:00.000Z",
    updatedAt: "2026-08-23T01:01:00.000Z",
    hasPrimaryFile: false,
    hasPreviewImage: true,
    previewAltText: `Preview ${index}`,
  }));
  mocks.listArtifactSummaryRecords.mockResolvedValue({
    items,
    nextCursor: null,
  });
  mocks.findPubliclySharedArtifactIds.mockResolvedValue(
    new Set(["artifact-0"]),
  );

  const result = await contentArtifactsService.listArtifactSummaries({
    workspaceId: "workspace-1",
    userId: "user-1",
    limit: 100,
  });
  const serialized = JSON.stringify(result);

  assert.ok(Buffer.byteLength(serialized) < 150 * 1024);
  assert.equal(serialized.includes("payloadJson"), false);
  assert.equal(serialized.includes("storageKey"), false);
  assert.equal(result.items[0]?.isPublic, true);
  assert.equal(
    result.items[0]?.previewImage?.url,
    "/v1/workspaces/workspace-1/artifacts/artifact-0/preview-image",
  );
  assert.equal(mocks.loadArtifactViewHandlerRegistry.mock.calls.length, 0);
});

test("a handler's download name wins over the payload file name", () => {
  const artifact = {
    artifactType: SYNTHETIC_FILE_ARTIFACT_TYPE,
    payloadJson: {
      fileName: "generated-legacy-name.bin",
    },
    title: "费曼学习法：用教别人的方式真正学会",
  };

  assert.equal(
    testExports.resolveArtifactFileName(
      artifact as never,
      handlerFor(SYNTHETIC_FILE_ARTIFACT_TYPE),
    ),
    `费曼学习法：用教别人的方式真正学会${SYNTHETIC_FILE_EXTENSION}`,
  );
});

test("artifact downloads keep the payload file name when no handler claims the type", () => {
  const artifact = {
    artifactType: "image",
    payloadJson: {
      fileName: "generated-image.png",
    },
    title: "Title",
  };

  assert.equal(
    testExports.resolveArtifactFileName(artifact as never),
    "generated-image.png",
  );
});

test("generic file artifacts keep payload file name and MIME type", () => {
  const artifact = {
    artifactType: "file",
    payloadJson: {
      fileName: "table.csv",
      mimeType: "text/csv",
    },
    title: "Table Export",
  };

  assert.equal(testExports.resolveArtifactFileName(artifact as never), "table.csv");
  assert.equal(testExports.resolveArtifactContentType(artifact as never), "text/csv");
});

test("artifact capabilities distinguish files from image artifacts", () => {
  assert.deepEqual(
    testExports.buildArtifactCapabilities({
      artifactType: "image",
      status: "ready",
      storageKey: "workspace/artifact/image.png",
    } as never),
    {
      canOpenFile: true,
      canDownloadFile: true,
      canPreviewInline: true,
      canRenderClientSide: false,
    },
  );
  assert.deepEqual(
    testExports.buildArtifactCapabilities({
      artifactType: "image",
      status: "pending",
      storageKey: null,
    } as never),
    {
      canOpenFile: false,
      canDownloadFile: false,
      canPreviewInline: false,
      canRenderClientSide: false,
    },
  );
});

test("generic file artifact preview capability follows MIME type", () => {
  assert.deepEqual(
    testExports.buildArtifactCapabilities({
      artifactType: "file",
      status: "ready",
      storageKey: "workspace/artifact/report.pdf",
      payloadJson: {
        mimeType: "application/pdf",
      },
    } as never),
    {
      canOpenFile: true,
      canDownloadFile: true,
      canPreviewInline: true,
      canRenderClientSide: false,
    },
  );
  assert.deepEqual(
    testExports.buildArtifactCapabilities({
      artifactType: "file",
      status: "ready",
      storageKey: "workspace/artifact/page.html",
      payloadJson: {
        mimeType: "text/html",
      },
    } as never),
    {
      canOpenFile: true,
      canDownloadFile: true,
      canPreviewInline: true,
      canRenderClientSide: false,
    },
  );
  assert.deepEqual(
    testExports.buildArtifactCapabilities({
      artifactType: "file",
      status: "ready",
      storageKey: "workspace/artifact/data.csv",
      payloadJson: {
        mimeType: "text/csv; charset=utf-8",
      },
    } as never),
    {
      canOpenFile: true,
      canDownloadFile: true,
      canPreviewInline: true,
      canRenderClientSide: false,
    },
  );
  assert.deepEqual(
    testExports.buildArtifactCapabilities({
      artifactType: "file",
      status: "ready",
      storageKey: "workspace/artifact/archive.zip",
      payloadJson: {
        mimeType: "application/zip",
      },
    } as never),
    {
      canOpenFile: true,
      canDownloadFile: true,
      canPreviewInline: false,
      canRenderClientSide: false,
    },
  );
  assert.deepEqual(
    testExports.buildArtifactCapabilities({
      artifactType: "file",
      status: "ready",
      storageKey: "workspace/artifact/report.xlsx",
      payloadJson: {
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    } as never),
    {
      canOpenFile: true,
      canDownloadFile: true,
      canPreviewInline: false,
      canRenderClientSide: false,
    },
  );
});

test("a registered takeover makes an artifact client-renderable without a file", () => {
  const registry = handlers;
  const artifact = {
    artifactType: SYNTHETIC_TAKEOVER_ARTIFACT_TYPE,
    status: "running",
    storageKey: null,
  };

  assert.deepEqual(
    testExports.buildArtifactCapabilities(
      artifact as never,
      registry.handlerFor(artifact.artifactType),
    ),
    {
      canOpenFile: true,
      canDownloadFile: false,
      canPreviewInline: false,
      canRenderClientSide: true,
    },
  );
  // Failed artifacts render nothing, takeover or not.
  assert.deepEqual(
    testExports.buildArtifactCapabilities(
      { ...artifact, status: "failed" } as never,
      registry.handlerFor(artifact.artifactType),
    ),
    {
      canOpenFile: false,
      canDownloadFile: false,
      canPreviewInline: false,
      canRenderClientSide: false,
    },
  );
  // No takeover registered for the type: generic file fallback only.
  assert.deepEqual(
    testExports.buildArtifactCapabilities(artifact as never, registry.handlerFor("file")),
    {
      canOpenFile: false,
      canDownloadFile: false,
      canPreviewInline: false,
      canRenderClientSide: false,
    },
  );
});

test("a handler's payload-stored primary file is downloadable without a top-level file", () => {
  // A takeover whose deliverable lives in the payload (e.g. a video
  // presentation's rendered mp4), not the top-level storageKey column.
  const withPrimaryFile = createSyntheticTakeoverArtifactViewHandler({
    resolvePrimaryFile: ({ artifact }) => {
      const payload = artifact.payloadJson as { renderedVideo?: unknown };
      const rendered = payload?.renderedVideo as
        | { fileName?: string; storageKey?: string }
        | undefined;
      return rendered?.storageKey && rendered.fileName
        ? {
            contentType: "video/mp4",
            fileName: rendered.fileName,
            storageBucket: artifact.storageBucket,
            storageKey: rendered.storageKey,
          }
        : null;
    },
  });

  // Ready + a resolvable primary file → downloadable, still client-rendered.
  assert.deepEqual(
    testExports.buildArtifactCapabilities(
      {
        artifactType: SYNTHETIC_TAKEOVER_ARTIFACT_TYPE,
        status: "ready",
        storageKey: null,
        payloadJson: {
          renderedVideo: {
            fileName: "deck.mp4",
            storageKey: "workspaces/w1/artifacts/a1/deck.mp4",
          },
        },
      } as never,
      withPrimaryFile,
    ),
    {
      canOpenFile: true,
      canDownloadFile: true,
      canPreviewInline: false,
      canRenderClientSide: true,
    },
  );

  // Same handler, but the payload has no rendered mp4 (the browser-compiled
  // path): resolvePrimaryFile returns null, so download stays off by design.
  assert.deepEqual(
    testExports.buildArtifactCapabilities(
      {
        artifactType: SYNTHETIC_TAKEOVER_ARTIFACT_TYPE,
        status: "ready",
        storageKey: null,
        payloadJson: { videoDownloadOnly: true },
      } as never,
      withPrimaryFile,
    ),
    {
      canOpenFile: true,
      canDownloadFile: false,
      canPreviewInline: false,
      canRenderClientSide: true,
    },
  );
});

test("artifact asset resolution delegates payload shapes to the type handler", () => {
  const registry = handlers;
  const artifact = {
    artifactType: SYNTHETIC_TAKEOVER_ARTIFACT_TYPE,
    status: "ready",
    storageBucket: "content",
    storageKey: null,
    payloadJson: {
      syntheticAssets: [
        {
          fileName: "scene-1.mp3",
          mimeType: "audio/mpeg",
          storageKey: "workspaces/w1/artifacts/a1/scene-1.mp3",
        },
      ],
    },
  };

  assert.deepEqual(
    testExports.resolveArtifactAsset(
      artifact as never,
      "scene-1.mp3",
      registry.handlerFor(artifact.artifactType),
    ),
    {
      contentType: "audio/mpeg",
      fileName: "scene-1.mp3",
      storageBucket: "content",
      storageKey: "workspaces/w1/artifacts/a1/scene-1.mp3",
    },
  );
  // Without the handler the backend knows nothing about that payload shape.
  assert.equal(
    testExports.resolveArtifactAsset(artifact as never, "scene-1.mp3"),
    null,
  );
});

test("artifact preview image metadata resolves from structured fields", () => {
  assert.deepEqual(
    testExports.resolveArtifactPreviewImage({
      artifactType: SYNTHETIC_FILE_ARTIFACT_TYPE,
      status: "ready",
      storageBucket: "content",
      previewStorageKey: "workspaces/workspace-1/artifacts/artifact-1/preview.jpg",
      previewMetadataJson: {
        mimeType: "image/jpeg",
        fileName: "preview.jpg",
      },
    } as never),
    {
      contentType: "image/jpeg",
      fileName: "preview.jpg",
      storageBucket: "content",
      storageKey: "workspaces/workspace-1/artifacts/artifact-1/preview.jpg",
    },
  );
});

test("artifact preview image metadata is unavailable for missing payload", () => {
  assert.equal(
    testExports.resolveArtifactPreviewImage({
      status: "ready",
      previewStorageKey: null,
      previewMetadataJson: {},
    } as never),
    null,
  );
});
