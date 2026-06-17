import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildArtifactPreviewUrl,
  buildImageRuntimePromptLines,
  buildImageToolResult,
  generateImageSchema,
  sanitizeImageArtifactFileBase,
} from "../src/index";

test("image schema rejects malformed inputs", () => {
  assert.equal(
    generateImageSchema.safeParse({ prompt: "Draw a launch image" }).success,
    true,
  );
  assert.equal(generateImageSchema.safeParse({ prompt: "   " }).success, false);
  assert.equal(
    generateImageSchema.safeParse({
      prompt: "Draw a launch image",
      title: "x".repeat(161),
    }).success,
    false,
  );
});

test("image prompt and result helpers preserve backend behavior", () => {
  const lines = buildImageRuntimePromptLines({
    toolName: "generate_image",
    config: { aspectRatio: "16:9", quality: "high", style: "natural" },
  });

  assert.equal(
    lines.some((line) => line.includes("aspect_ratio=16:9")),
    true,
  );
  assert.equal(
    sanitizeImageArtifactFileBase("Q4 / Board: Review?"),
    "q4-board-review",
  );
  assert.equal(sanitizeImageArtifactFileBase("   "), "generated-image");
  assert.equal(
    buildArtifactPreviewUrl({
      artifactId: "artifact 1",
      workspaceId: "workspace 1",
    }),
    "/artifact-preview?artifactId=artifact+1&workspaceId=workspace+1",
  );

  const result = buildImageToolResult({
    artifactId: "artifact-1",
    artifactUrl:
      "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
    config: { aspectRatio: "4:3", quality: "standard", style: "vivid" },
    height: 768,
    provider: "openai",
    providerModel: "gpt-image-1",
    title: "Launch Image",
    versionId: "version-1",
    width: 1024,
  });

  assert.equal(
    result,
    [
      "Image artifact created.",
      "artifact_id: artifact-1",
      "version_id: version-1",
      "title: Launch Image",
      "artifact_url: /artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
      "aspect_ratio: 4:3",
      "width: 1024",
      "height: 768",
      "quality: standard",
      "style: vivid",
      "provider: openai",
      "provider_model: gpt-image-1",
      "The application will display the generated image automatically. Do not include image markdown or repeat raw URLs.",
    ].join("\n"),
  );
  assert.doesNotMatch(result, /!\[\]\(/u);
});
