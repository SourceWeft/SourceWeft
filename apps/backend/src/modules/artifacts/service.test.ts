import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { videoPresentationArtifactViewHandler } from "@sourceweft/builtin-tool-video-presentation";
import { slidesArtifactViewHandler } from "@sourceweft/builtin-tool-publish-artifact";
import { testExports } from "./service";
import { createArtifactViewHandlerRegistry } from "./view-handlers";

const handlers = createArtifactViewHandlerRegistry([
  slidesArtifactViewHandler,
  videoPresentationArtifactViewHandler,
]);

function handlerFor(artifactType: string) {
  return handlers.handlerFor(artifactType);
}

vi.mock("../workspace/guards", () => ({
  requireContentWorkspace: vi.fn(),
}));

vi.mock("../sources/storage", () => ({
  downloadArtifactObject: vi.fn(),
}));

vi.mock("./repository", () => ({
  findArtifactRecord: vi.fn(),
  listArtifactRecords: vi.fn(),
}));

test("slides artifact downloads use artifact title over legacy payload file name", () => {
  const artifact = {
    artifactType: "slides",
    payloadJson: {
      fileName: "generated-pptx.pptx",
    },
    title: "费曼学习法：用教别人的方式真正学会",
  };

  assert.equal(
    testExports.resolveArtifactFileName(artifact as never, handlerFor("slides")),
    "费曼学习法-用教别人的方式真正学会.pptx",
  );
});

test("visual HTML slides artifact keeps HTML payload file name", () => {
  const artifact = {
    artifactType: "slides",
    payloadJson: {
      fileName: "deck.html",
      generationMode: "visual_html",
    },
    title: "Visual Deck",
  };

  assert.equal(
    testExports.resolveArtifactFileName(artifact as never, handlerFor("slides")),
    "deck.html",
  );
});

test("visual HTML slides artifact advertises visual deck renderer", () => {
  assert.equal(
    testExports.resolveArtifactRenderer(
      {
        artifactType: "slides",
        payloadJson: {
          generationMode: "visual_html",
        },
      } as never,
      handlerFor("slides"),
    ),
    "visual_html_deck",
  );
  assert.equal(
    testExports.resolveArtifactRenderer(
      {
        artifactType: "slides",
        payloadJson: {
          generationMode: "editable_native",
        },
      } as never,
      handlerFor("slides"),
    ),
    null,
  );
  assert.equal(
    testExports.resolveArtifactRenderer(
      {
        artifactType: "image",
        payloadJson: {
          generationMode: "visual_html",
        },
      } as never,
      handlerFor("image"),
    ),
    null,
  );
});

test("non-slides artifact downloads keep payload file name", () => {
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
    artifactType: "video_presentation",
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

test("artifact asset resolution delegates payload shapes to the type handler", () => {
  const registry = handlers;
  const artifact = {
    artifactType: "video_presentation",
    status: "ready",
    storageBucket: "content",
    storageKey: null,
    payloadJson: {
      audioTracks: [
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
      artifactType: "slides",
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
