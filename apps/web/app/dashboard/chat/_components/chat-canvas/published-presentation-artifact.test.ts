// The published-deck readers now live in the capability package, but they are
// exercised here because the transport-level decoding they are handed (JSON in
// a tool message, `key: value` text, structured records) is the app shell's.
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  buildPublishedPresentationPreviewRecord,
  getPublishedPresentationFileName,
  isPublishedPresentationPending,
  publishedPresentationDownloadName,
  resolvePublishedPresentationArtifact,
  resolvePublishedPresentationThumbnailUrl,
  shouldShowPublishedPresentationItem,
} from "@sourceweft/builtin-tool-publish-artifact/ui";
import "../artifact-render-host";
import { getToolOutputField, getToolOutputValue } from "./message-assets";
import type { ToolCallRecord } from "./types";

function resolve(toolCall: ToolCallRecord) {
  return resolvePublishedPresentationArtifact({
    readField: (key) => getToolOutputField(toolCall.output, key),
    readValue: (key) => getToolOutputValue(toolCall.output, key),
    toolCall,
  });
}

function toolCall(overrides: Partial<ToolCallRecord>): ToolCallRecord {
  return {
    id: "tool-1",
    tool: "publish_artifact",
    input: {},
    output: null,
    latencyMs: 10,
    status: "completed",
    error: null,
    ...overrides,
  } as ToolCallRecord;
}

test("resolves presentation artifacts from JSON tool message content", () => {
  assert.deepEqual(
    resolve(
      toolCall({
        output: {
          content: JSON.stringify({
            type: "presentation_artifact_result",
            artifact_id: "artifact-1",
            artifact_url:
              "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
            editable: false,
            file_name: "feynman.pptx",
            generation_mode: "visual_html",
            html_url:
              "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
            preview_renderer: "html_iframe",
            slide_count: 12,
            source_json_url:
              "/v1/workspaces/workspace-1/artifacts/artifact-1/source.json",
            title: "费曼学习法",
          }),
        },
      }),
    ),
    {
      artifactId: "artifact-1",
      artifactUrl:
        "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
      editable: false,
      fileName: "feynman.pptx",
      generationMode: "visual_html",
      htmlUrl:
        "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
      pptxUrl: null,
      previewImageUrl: null,
      previewRenderer: "html_iframe",
      renderStrategy: null,
      slideCount: 12,
      sourceJsonUrl:
        "/v1/workspaces/workspace-1/artifacts/artifact-1/source.json",
      status: null,
      title: "费曼学习法",
    },
  );
});

test("does not resolve presentation artifact from needs_content tool output", () => {
  assert.equal(
    resolve(
      toolCall({
        output: {
          content: JSON.stringify({
            type: "presentation_artifact_input_required",
            status: "needs_content",
            title: "费曼学习法",
          }),
        },
      }),
    ),
    null,
  );
});

test("does not resolve published sandbox presentation artifact without URL", () => {
  assert.equal(
    resolve(
      toolCall({
        output: {
          ok: true,
          type: "presentation_artifact_result",
          status: "ready",
          artifactType: "slides",
          title: "费曼学习法介绍",
          fileName: "费曼学习法介绍.pptx",
          file_name: "费曼学习法介绍.pptx",
          generation_mode: "editable_native",
        },
      }),
    ),
    null,
  );
});

test("does not resolve errored sandbox presentation artifact with only artifact id", () => {
  assert.equal(
    resolve(
      toolCall({
        error: "publish failed",
        output: {
          ok: false,
          type: "presentation_artifact_error",
          status: "failed",
          artifact_id: "artifact-1",
          title: "费曼学习法介绍",
        },
      }),
    ),
    null,
  );
});

test("does not resolve errored sandbox presentation artifact even with URL", () => {
  assert.equal(
    resolve(
      toolCall({
        error: "publish failed",
        output: {
          ok: true,
          type: "presentation_artifact_result",
          status: "ready",
          artifact_id: "artifact-1",
          artifact_url:
            "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
          pptx_url:
            "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
          title: "费曼学习法介绍",
        },
      }),
    ),
    null,
  );
});

test("only the publishing tool produces a published-deck card", () => {
  assert.equal(
    resolve(
      toolCall({
        tool: "unrelated_artifact_tool",
        output: {
          type: "unrelated_artifact_result",
          artifact_id: "artifact-1",
          artifact_url:
            "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
          status: "ready",
          title: "Launch plan",
        },
      }),
    ),
    null,
  );
});

test("resolves published sandbox presentation artifact output", () => {
  assert.deepEqual(
    resolve(
      toolCall({
        output: {
          ok: true,
          type: "presentation_artifact_result",
          status: "ready",
          artifactId: "artifact-1",
          artifact_id: "artifact-1",
          artifactType: "slides",
          title: "费曼学习法介绍",
          artifactUrl:
            "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
          artifact_url:
            "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
          pptx_url:
            "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
          preview_image_url:
            "/api/artifact-file?artifactId=artifact-1&workspaceId=workspace-1&asset=previewImage",
          byteLength: 42,
          byte_length: 42,
          editable: true,
          fileName: "费曼学习法介绍.pptx",
          file_name: "费曼学习法介绍.pptx",
          generation_mode: "editable_native",
          qaWarnings: [],
        },
      }),
    ),
    {
      artifactId: "artifact-1",
      artifactUrl:
        "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
      editable: true,
      fileName: "费曼学习法介绍.pptx",
      generationMode: "editable_native",
      htmlUrl: null,
      pptxUrl:
        "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
      previewImageUrl:
        "/api/artifact-file?artifactId=artifact-1&workspaceId=workspace-1&asset=previewImage",
      previewRenderer: null,
      renderStrategy: null,
      slideCount: null,
      sourceJsonUrl: null,
      status: "ready",
      title: "费曼学习法介绍",
    },
  );
});

// ---------------------------------------------------------------------------
// thumbnails
// ---------------------------------------------------------------------------

test("published deck thumbnail resolves tool output asset URLs", () => {
  assert.equal(
    resolvePublishedPresentationThumbnailUrl({
      previewImageUrl:
        "/api/artifact-file?artifactId=artifact-1&workspaceId=workspace-1&asset=previewImage",
    }),
    "/api/artifact-file?artifactId=artifact-1&workspaceId=workspace-1&asset=previewImage",
  );
});

test("published deck thumbnail resolves persisted snapshot metadata", () => {
  assert.equal(
    resolvePublishedPresentationThumbnailUrl({
      artifactPreview: {
        id: "artifact-1",
        workspaceId: "workspace-1",
        previewMetadataJson: {
          fileName: "preview.jpg",
          mimeType: "image/jpeg",
        },
        previewStorageKey: "artifacts/workspace-1/artifact-1/preview.jpg",
      },
    }),
    "/api/artifact-file?artifactId=artifact-1&workspaceId=workspace-1&asset=previewImage",
  );
});

test("published deck thumbnail returns null without metadata", () => {
  assert.equal(
    resolvePublishedPresentationThumbnailUrl({
      artifactPreview: {
        id: "artifact-1",
        workspaceId: "workspace-1",
        previewMetadataJson: {},
        previewStorageKey: null,
      },
    }),
    null,
  );
});

// ---------------------------------------------------------------------------
// download names + card visibility
// ---------------------------------------------------------------------------

test("publishedPresentationDownloadName sanitizes and appends the extension", () => {
  // Illegal chars become "-", then surrounding whitespace is collapsed away.
  assert.equal(
    publishedPresentationDownloadName("Q3 / Review: Draft"),
    "Q3-Review-Draft.pptx",
  );
  assert.equal(
    publishedPresentationDownloadName("   "),
    "generated-presentation.pptx",
  );
  // Already-correct extension is preserved rather than doubled.
  assert.equal(publishedPresentationDownloadName("deck.pptx"), "deck.pptx");
  // A mismatched presentation extension is swapped, not appended.
  assert.equal(publishedPresentationDownloadName("deck.html"), "deck.pptx");
  assert.equal(
    publishedPresentationDownloadName("deck.pptx", "html"),
    "deck.html",
  );
});

test("getPublishedPresentationFileName routes by generation mode", () => {
  assert.equal(
    getPublishedPresentationFileName({
      artifactFileName: "deck",
      generationMode: "visual_html",
    }),
    "deck.html",
  );
  assert.equal(
    getPublishedPresentationFileName({
      artifactFileName: "deck",
      generationMode: "editable_native",
    }),
    "deck.pptx",
  );
});

test("getPublishedPresentationFileName prefers artifact file name over title", () => {
  assert.equal(
    getPublishedPresentationFileName({
      artifactFileName: "from-artifact",
      title: "from-title",
    }),
    "from-artifact.pptx",
  );
});

test("isPublishedPresentationPending covers pending and running only", () => {
  assert.equal(isPublishedPresentationPending("pending"), true);
  assert.equal(isPublishedPresentationPending("running"), true);
  assert.equal(isPublishedPresentationPending("ready"), false);
  assert.equal(isPublishedPresentationPending(null), false);
  assert.equal(isPublishedPresentationPending(undefined), false);
});

test("the publisher card waits for a completed artifact URL", () => {
  assert.equal(
    shouldShowPublishedPresentationItem({
      fileUrl: null,
      isArtifactPublisher: true,
      status: "running",
    }),
    false,
  );
  assert.equal(
    shouldShowPublishedPresentationItem({
      fileUrl: null,
      isArtifactPublisher: true,
      status: "approval_requested",
    }),
    false,
  );
  assert.equal(
    shouldShowPublishedPresentationItem({
      fileUrl: "/artifact-preview?artifactId=artifact-1",
      isArtifactPublisher: true,
      status: "completed",
    }),
    true,
  );
  assert.equal(
    shouldShowPublishedPresentationItem({
      fileUrl: null,
      isArtifactPublisher: true,
      status: "completed",
    }),
    false,
  );
});

// ---------------------------------------------------------------------------
// buildPublishedPresentationPreviewRecord
// ---------------------------------------------------------------------------

test("buildPublishedPresentationPreviewRecord requires ids and a file url", () => {
  const base = {
    artifactId: "artifact-1",
    fileUrl: "https://cdn.example/deck.pptx",
    generationMode: "editable_native" as const,
    source: {},
    title: "Deck",
    workspaceId: "workspace-1",
  };
  assert.equal(
    buildPublishedPresentationPreviewRecord({ ...base, artifactId: null }),
    null,
  );
  assert.equal(
    buildPublishedPresentationPreviewRecord({ ...base, workspaceId: null }),
    null,
  );
  assert.equal(
    buildPublishedPresentationPreviewRecord({ ...base, fileUrl: null }),
    null,
  );
});

test("buildPublishedPresentationPreviewRecord builds a slides preview", () => {
  const artifact = buildPublishedPresentationPreviewRecord({
    artifactId: "artifact-1",
    fileUrl: "https://cdn.example/deck.pptx",
    generationMode: null,
    source: {
      fileName: "deck.pptx",
      htmlUrl: "https://cdn.example/deck.html",
      pptxUrl: "https://cdn.example/deck.pptx",
      slideCount: 12,
    },
    title: "Deck",
    workspaceId: "workspace-1",
  });
  assert.ok(artifact);
  assert.equal(artifact.artifactType, "slides");
  assert.equal(artifact.status, "ready");
  assert.equal(artifact.workspaceId, "workspace-1");
  // htmlUrl with no explicit mode implies visual_html + iframe rendering.
  assert.equal(artifact.payloadJson.generationMode, "visual_html");
  assert.equal(artifact.payloadJson.previewRenderer, "html_iframe");
  assert.equal(artifact.payloadJson.slideCount, 12);
  assert.equal(artifact.capabilities.canDownloadFile, true);
  assert.equal(artifact.capabilities.canRenderClientSide, false);
});

test("buildPublishedPresentationPreviewRecord omits pptx without a file name", () => {
  const artifact = buildPublishedPresentationPreviewRecord({
    artifactId: "artifact-3",
    fileUrl: "https://cdn.example/deck.pptx",
    generationMode: "editable_native",
    source: { pptxUrl: "https://cdn.example/deck.pptx" },
    title: "Deck",
    workspaceId: "workspace-1",
  });
  assert.ok(artifact);
  assert.equal(artifact.payloadJson.pptx, undefined);
  assert.equal(artifact.payloadJson.previewRenderer, "pptxviewjs");
  assert.equal(artifact.payloadJson.editable, true);
});
