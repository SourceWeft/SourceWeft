import assert from "node:assert/strict";
import { test } from "vitest";
import {
  resolveArtifactDownloadUrl,
  resolveArtifactUrl,
  resolveGeneratedPresentationArtifact,
} from "./message-assets";
import type { ToolCallRecord } from "./types";

test("resolves presentation artifacts from JSON tool message content", () => {
  const toolCall: ToolCallRecord = {
    id: "tool-1",
    tool: "generate_pptx",
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
    htmlUrl:
      "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
    pptxUrl: null,
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
    tool: "generate_pptx",
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
      status: "pending",
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
    previewRenderer: null,
    renderStrategy: "frontend_remotion_project_to_video",
    slideCount: null,
    sourceJsonUrl: null,
    status: "pending",
    title: "Launch plan",
  });
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

test("resolveArtifactDownloadUrl maps generated artifact downloads through the file proxy", () => {
  assert.equal(
    resolveArtifactDownloadUrl({
      artifact: { artifactId: "artifact-1" },
      workspaceId: "workspace-1",
    }),
    "/api/artifact-file?artifactId=artifact-1&workspaceId=workspace-1&download=1",
  );
});
