import assert from "node:assert/strict";
import { test } from "vitest";
import {
  resolveArtifactDownloadUrl,
  resolveArtifactFileUrl,
  resolveArtifactUrl,
  resolveGeneratedPresentationArtifact,
  resolveGeneratedPresentationPreviewImageUrl,
} from "./message-assets";
import type { ToolCallRecord } from "./types";

test("resolves presentation artifacts from JSON tool message content", () => {
  const toolCall: ToolCallRecord = {
    id: "tool-1",
    tool: "publish_artifact",
    input: {},
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
    latencyMs: 10,
    status: "completed",
    error: null,
  };

  assert.deepEqual(resolveGeneratedPresentationArtifact(toolCall), {
    artifactId: "artifact-1",
    artifactUrl:
      "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
    editable: false,
    fileName: "feynman.pptx",
    generationMode: "visual_html",
    htmlUrl: "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
    pptxUrl: null,
    previewImageUrl: null,
    previewRenderer: "html_iframe",
    renderStrategy: null,
    slideCount: 12,
    sourceJsonUrl:
      "/v1/workspaces/workspace-1/artifacts/artifact-1/source.json",
    status: null,
    title: "费曼学习法",
  });
});

test("does not resolve presentation artifact from needs_content tool output", () => {
  const toolCall: ToolCallRecord = {
    id: "tool-1",
    tool: "publish_artifact",
    input: {},
    output: {
      content: JSON.stringify({
        type: "presentation_artifact_input_required",
        status: "needs_content",
        title: "费曼学习法",
      }),
    },
    latencyMs: 10,
    status: "completed",
    error: null,
  };

  assert.equal(resolveGeneratedPresentationArtifact(toolCall), null);
});

test("does not resolve published sandbox presentation artifact without URL", () => {
  const toolCall: ToolCallRecord = {
    id: "tool-1",
    tool: "publish_artifact",
    input: {},
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
    latencyMs: 10,
    status: "completed",
    error: null,
  };

  assert.equal(resolveGeneratedPresentationArtifact(toolCall), null);
});

test("does not resolve errored sandbox presentation artifact with only artifact id", () => {
  const toolCall: ToolCallRecord = {
    id: "tool-1",
    tool: "publish_artifact",
    input: {},
    output: {
      ok: false,
      type: "presentation_artifact_error",
      status: "failed",
      artifact_id: "artifact-1",
      title: "费曼学习法介绍",
    },
    latencyMs: 10,
    status: "completed",
    error: "publish failed",
  };

  assert.equal(resolveGeneratedPresentationArtifact(toolCall), null);
});

test("does not resolve errored sandbox presentation artifact even with URL", () => {
  const toolCall: ToolCallRecord = {
    id: "tool-1",
    tool: "publish_artifact",
    input: {},
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
    latencyMs: 10,
    status: "completed",
    error: "publish failed",
  };

  assert.equal(resolveGeneratedPresentationArtifact(toolCall), null);
});

test("resolves published sandbox presentation artifact output", () => {
  const toolCall: ToolCallRecord = {
    id: "tool-1",
    tool: "publish_artifact",
    input: {},
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
    latencyMs: 10,
    status: "completed",
    error: null,
  };

  assert.deepEqual(resolveGeneratedPresentationArtifact(toolCall), {
    artifactId: "artifact-1",
    artifactUrl:
      "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
    editable: true,
    fileName: "费曼学习法介绍.pptx",
    generationMode: "editable_native",
    htmlUrl: null,
    pptxUrl: "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
    previewImageUrl:
      "/api/artifact-file?artifactId=artifact-1&workspaceId=workspace-1&asset=previewImage",
    previewRenderer: null,
    renderStrategy: null,
    slideCount: null,
    sourceJsonUrl: null,
    status: "ready",
    title: "费曼学习法介绍",
  });
});

test("generated presentation preview image resolves tool output asset URLs", () => {
  assert.equal(
    resolveGeneratedPresentationPreviewImageUrl({
      previewImageUrl:
        "/api/artifact-file?artifactId=artifact-1&workspaceId=workspace-1&asset=previewImage",
    }),
    "/api/artifact-file?artifactId=artifact-1&workspaceId=workspace-1&asset=previewImage",
  );
});

test("generated presentation preview image resolves persisted snapshot metadata", () => {
  assert.equal(
    resolveGeneratedPresentationPreviewImageUrl({
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

test("generated presentation preview image returns null without metadata", () => {
  assert.equal(
    resolveGeneratedPresentationPreviewImageUrl({
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

test("resolves video presentation artifacts from tool output", () => {
  const toolCall: ToolCallRecord = {
    id: "tool-1",
    tool: "generate_video_presentation",
    input: {},
    output: {
      type: "video_presentation_artifact_result",
      artifact_id: "artifact-1",
      artifact_url:
        "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
      file_name: "launch.mp4",
      render_strategy: "frontend_remotion_project_to_video",
      status: "ready",
      title: "Launch plan",
    },
    latencyMs: 10,
    status: "completed",
    error: null,
  };

  assert.deepEqual(resolveGeneratedPresentationArtifact(toolCall), {
    artifactId: "artifact-1",
    artifactUrl:
      "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
    editable: null,
    fileName: "launch.mp4",
    generationMode: null,
    htmlUrl: null,
    pptxUrl: null,
    previewImageUrl: null,
    previewRenderer: null,
    renderStrategy: "frontend_remotion_project_to_video",
    slideCount: null,
    sourceJsonUrl: null,
    status: "ready",
    title: "Launch plan",
  });
});

test("resolves running video presentation outputs into artifact cards", () => {
  const toolCall: ToolCallRecord = {
    id: "tool-1",
    tool: "generate_video_presentation",
    input: {},
    output: {
      type: "video_presentation_processing_result",
      artifact_id: "artifact-1",
      artifact_url:
        "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
      file_name: "launch.video-presentation.json",
      render_strategy: "frontend_remotion_project_to_video",
      status: "running",
      title: "Launch plan",
    },
    latencyMs: 10,
    status: "completed",
    error: null,
  };

  assert.deepEqual(resolveGeneratedPresentationArtifact(toolCall), {
    artifactId: "artifact-1",
    artifactUrl:
      "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
    editable: null,
    fileName: "launch.video-presentation.json",
    generationMode: null,
    htmlUrl: null,
    pptxUrl: null,
    previewImageUrl: null,
    previewRenderer: null,
    renderStrategy: "frontend_remotion_project_to_video",
    slideCount: null,
    sourceJsonUrl: null,
    status: "running",
    title: "Launch plan",
  });
});

test("resolves streamed video presentation progress into artifact cards", () => {
  const toolCall: ToolCallRecord = {
    id: "tool-1",
    tool: "generate_video_presentation",
    input: {},
    output: {
      type: "generate_video_presentation_progress",
      artifact_id: "artifact-1",
      artifact_url:
        "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
      file_name: "launch.video-presentation.json",
      progress: 64,
      stage: "generating_scene_modules",
      status: "running",
      title: "Launch plan",
    },
    latencyMs: null,
    status: "running",
    error: null,
  };

  const artifact = resolveGeneratedPresentationArtifact(toolCall);
  assert.equal(artifact?.artifactId, "artifact-1");
  assert.equal(artifact?.status, "running");
  assert.equal(artifact?.title, "Launch plan");
});

test("resolveArtifactUrl maps generated artifact files through the web preview proxy", () => {
  assert.equal(
    resolveArtifactUrl({
      artifact: {
        artifactId: "artifact-1",
        artifactUrl: "/v1/workspaces/workspace-1/artifacts/artifact-1/file",
        title: "Artifact",
      },
      workspaceId: "workspace-1",
    }),
    "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
  );
});

test("resolveArtifactFileUrl maps generated image artifacts through the file proxy", () => {
  assert.equal(
    resolveArtifactFileUrl({
      artifact: {
        artifactId: "artifact-1",
        artifactUrl:
          "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
      },
      workspaceId: "workspace-1",
    }),
    "/api/artifact-file?artifactId=artifact-1&workspaceId=workspace-1",
  );
});

test("resolveArtifactDownloadUrl maps generated artifact downloads through the file proxy", () => {
  assert.equal(
    resolveArtifactDownloadUrl({
      artifact: { artifactId: "artifact-1" },
      workspaceId: "workspace-1",
    }),
    "/api/artifact-file?artifactId=artifact-1&workspaceId=workspace-1&download=1",
  );
});
