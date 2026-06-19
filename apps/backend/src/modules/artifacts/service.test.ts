import assert from "node:assert/strict";
import { test } from "vitest";
import { testExports } from "./service";

test("slides artifact downloads use artifact title over legacy payload file name", () => {
  const artifact = {
    artifactType: "slides",
    payloadJson: {
      fileName: "generated-pptx.pptx",
    },
    title: "费曼学习法：用教别人的方式真正学会",
  };

  assert.equal(
    testExports.resolveArtifactFileName(artifact as never),
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
    testExports.resolveArtifactFileName(artifact as never),
    "deck.html",
  );
});

test("visual HTML slides artifact advertises visual deck renderer", () => {
  assert.equal(
    testExports.resolveArtifactRenderer({
      artifactType: "slides",
      payloadJson: {
        generationMode: "visual_html",
      },
    } as never),
    "visual_html_deck",
  );
  assert.equal(
    testExports.resolveArtifactRenderer({
      artifactType: "slides",
      payloadJson: {
        generationMode: "editable_native",
      },
    } as never),
    null,
  );
  assert.equal(
    testExports.resolveArtifactRenderer({
      artifactType: "image",
      payloadJson: {
        generationMode: "visual_html",
      },
    } as never),
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
      canRenderClientVideo: false,
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
      canRenderClientVideo: false,
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
      canRenderClientVideo: false,
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
      canRenderClientVideo: false,
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
      canRenderClientVideo: false,
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
      canRenderClientVideo: false,
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
      canRenderClientVideo: false,
    },
  );
});

test("video presentation artifact advertises browser render capability", () => {
  assert.deepEqual(
    testExports.buildArtifactCapabilities({
      artifactType: "video_presentation",
      status: "running",
      storageKey: null,
    } as never),
    {
      canOpenFile: false,
      canDownloadFile: false,
      canPreviewInline: false,
      canRenderClientVideo: true,
    },
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
