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

test("video presentation pending artifact falls back to project manifest file name", () => {
  const artifact = {
    artifactType: "video_presentation",
    payloadJson: {},
    title: "费曼学习法",
  };

  assert.equal(
    testExports.resolveArtifactFileName(artifact as never),
    "费曼学习法.video-presentation.json",
  );
});

test("video presentation exposes preview route while render job is pending", () => {
  assert.equal(
    testExports.hasArtifactPreviewFile({
      artifactType: "video_presentation",
      status: "pending",
      storageKey: "workspace/artifact/feynman.mp4",
    } as never),
    true,
  );
  assert.equal(
    testExports.hasArtifactPreviewFile({
      artifactType: "slides",
      status: "pending",
      storageKey: "workspace/artifact/deck.html",
    } as never),
    false,
  );
  assert.equal(
    testExports.hasArtifactPreviewFile({
      artifactType: "video_presentation",
      status: "failed",
      storageKey: "workspace/artifact/feynman.mp4",
    } as never),
    false,
  );
});

test("artifact capabilities distinguish files from client-rendered video projects", () => {
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
      artifactType: "video_presentation",
      status: "ready",
      storageKey: null,
    } as never),
    {
      canOpenFile: false,
      canDownloadFile: false,
      canPreviewInline: true,
      canRenderClientVideo: true,
    },
  );
  assert.deepEqual(
    testExports.buildArtifactCapabilities({
      artifactType: "video_presentation",
      status: "pending",
      storageKey: null,
    } as never),
    {
      canOpenFile: false,
      canDownloadFile: false,
      canPreviewInline: true,
      canRenderClientVideo: false,
    },
  );
});

test("stale video presentation artifacts are surfaced as failed", async () => {
  const artifact = {
    artifactType: "video_presentation",
    status: "running",
    updatedAt: "2026-05-29T10:00:00.000Z",
    errorCode: null,
    errorMessage: null,
    payloadJson: {
      generation: { status: "running", stage: "planning" },
    },
  };

  assert.equal(
    testExports.isStaleVideoPresentationArtifact(
      artifact as never,
      new Date("2026-05-29T10:11:00.000Z"),
    ),
    true,
  );
  const normalized =
    (await testExports.withStaleVideoPresentationArtifactFailure(
      artifact as never,
      new Date("2026-05-29T10:11:00.000Z"),
      false,
    )) as {
      status: string;
      errorCode: string | null;
      payloadJson: { generation?: { status?: string; stage?: string } };
    };
  assert.equal(normalized.status, "failed");
  assert.equal(normalized.errorCode, "VIDEO_PRESENTATION_RENDER_STALE");
  assert.deepEqual(normalized.payloadJson.generation, {
    status: "failed",
    stage: "failed",
    errorCode: "VIDEO_PRESENTATION_RENDER_STALE",
    errorMessage:
      "Video presentation project generation did not complete. Please retry.",
  });
});

test("terminal failed video presentation jobs are surfaced as failed artifacts", async () => {
  const artifact = {
    artifactType: "video_presentation",
    status: "running",
    errorCode: null,
    errorMessage: null,
    payloadJson: {
      jobId: "video-presentation-render_artifact-1",
      generation: { status: "running", stage: "planning" },
    },
  };

  const normalized = (await testExports.withTerminalVideoPresentationJobFailure(
    artifact as never,
    {
      async getJob(jobId: string) {
        assert.equal(jobId, "video-presentation-render_artifact-1");
        return {
          failedReason: "job stalled more than allowable limit",
          async getState() {
            return "failed";
          },
        };
      },
    } as never,
    false,
  )) as {
    status: string;
    errorCode: string | null;
    payloadJson: { generation?: { status?: string; stage?: string } };
  };

  assert.equal(normalized.status, "failed");
  assert.equal(normalized.errorCode, "VIDEO_PRESENTATION_RENDER_FAILED");
  assert.equal(normalized.payloadJson.generation?.stage, "project_failed");
});

test("video presentation asset resolver exposes narration tracks only from manifest", () => {
  const artifact = {
    artifactType: "video_presentation",
    storageBucket: "content",
    storageKey: "workspace/artifact/deck.html",
    payloadJson: {
      fileName: "deck.html",
      mimeType: "text/html; charset=utf-8",
      html: { fileName: "deck.html" },
      video: {
        audioTracks: [
          {
            fileName: "narration-slide-01.mp3",
            mimeType: "audio/mpeg",
            storageBucket: "content",
            storageKey: "workspace/artifact/narration-slide-01.mp3",
          },
        ],
      },
    },
  };

  assert.deepEqual(
    testExports.resolveArtifactAsset(
      artifact as never,
      "narration-slide-01.mp3",
    ),
    {
      contentType: "audio/mpeg",
      fileName: "narration-slide-01.mp3",
      storageBucket: "content",
      storageKey: "workspace/artifact/narration-slide-01.mp3",
    },
  );
  assert.equal(
    testExports.resolveArtifactAsset(artifact as never, "missing.mp3"),
    null,
  );
});
