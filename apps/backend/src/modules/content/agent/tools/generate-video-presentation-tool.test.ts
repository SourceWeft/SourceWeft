import assert from "node:assert/strict";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { test } from "vitest";
import { testExports } from "./generate-video-presentation-tool";

test("generate_video_presentation tool schema can be represented as JSON Schema", () => {
  const jsonSchema = toJsonSchema(
    testExports.generateVideoPresentationSchema,
  );

  assert.equal((jsonSchema as { type?: unknown }).type, "object");
  assert.doesNotThrow(() => JSON.stringify(jsonSchema));
});

test("generate_video_presentation schema accepts simplified video inputs", () => {
  assert.deepEqual(
    testExports.parseGenerateVideoPresentationArgs({
      source_content: "Quarterly update: retention improved and pipeline softened.",
      video_title: "Quarterly Operating Review",
      user_prompt: "Executive, concise, cinematic but data-forward.",
      narration: { enabled: true },
    }),
    {
      source_content: "Quarterly update: retention improved and pipeline softened.",
      video_title: "Quarterly Operating Review",
      user_prompt: "Executive, concise, cinematic but data-forward.",
      narration: { enabled: true },
    },
  );
});

test("generate_video_presentation schema rejects PPTX-style design options", () => {
  assert.throws(() =>
    testExports.parseGenerateVideoPresentationArgs({
      source_content: "Create a video.",
      design: {
        aspectRatio: "16:9",
        stylePreset: "executive",
      },
    }),
  );
});

test("generate_video_presentation parser trims fields without JSON Schema transforms", () => {
  assert.deepEqual(
    testExports.parseGenerateVideoPresentationArgs({
      source_content: "  Source material  ",
      video_title: "  Launch plan  ",
      user_prompt: "  Calm pacing  ",
    }),
    {
      source_content: "Source material",
      video_title: "Launch plan",
      user_prompt: "Calm pacing",
    },
  );
});

test("initial payload describes pending browser-rendered Remotion project", () => {
  assert.deepEqual(
    testExports.buildInitialPayload({
      artifactId: "artifact-1",
      fileName: "Quarterly-Review.video-presentation.json",
      jobId: "video-presentation-render_artifact-1",
      narrationEnabled: true,
      requestKey: "video_presentation:workspace-1:thread-1:message-1",
      sourceContent: "Quarterly update source content.",
      title: "Quarterly Review",
      userPrompt: "Calm executive pacing.",
      workspaceId: "workspace-1",
    }),
    {
      title: "Quarterly Review",
      prompt: "Calm executive pacing.",
      artifactKind: "video_presentation",
      renderStrategy: "frontend_remotion_project_to_video",
      videoDownloadOnly: true,
      mimeType: "application/vnd.sourceweft.video-presentation+json",
      fileName: "Quarterly-Review.video-presentation.json",
      jobId: "video-presentation-render_artifact-1",
      requestKey: "video_presentation:workspace-1:thread-1:message-1",
      generation: {
        status: "pending",
        stage: "planning",
      },
      narrationEnabled: true,
      source: {
        contentPreview: "Quarterly update source content.",
        userPrompt: "Calm executive pacing.",
      },
      artifactUrl:
        "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
    },
  );
});

test("tool result advertises queued browser export project", () => {
  assert.deepEqual(
    testExports.buildToolResult({
      artifactId: "artifact-1",
      artifactUrl:
        "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
      fileName: "Launch-plan.video-presentation.json",
      jobId: "video-presentation-render_artifact-1",
      narrationEnabled: false,
      status: "pending",
      title: "Launch plan",
    }),
    {
      type: "video_presentation_artifact_result",
      artifact_id: "artifact-1",
      artifact_url:
        "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
      content:
        "Video presentation project queued: Launch-plan.video-presentation.json\n" +
        "The application is preparing the scene spec and narration assets in the background.",
      file_name: "Launch-plan.video-presentation.json",
      job_id: "video-presentation-render_artifact-1",
      narration_enabled: false,
      render_strategy: "frontend_remotion_project_to_video",
      status: "pending",
      title: "Launch plan",
      video_download_only: true,
    },
  );
});

test("video presentation request key is stable per source message", () => {
  assert.equal(
    testExports.buildVideoPresentationRequestKey({
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userMessageId: "message-1",
    }),
    "video_presentation:workspace-1:thread-1:message-1",
  );
});

test("video presentation project file base names are sanitized", () => {
  assert.equal(
    testExports.sanitizeVideoPresentationFileBase("Q4 / Board: Review?"),
    "Q4-Board-Review",
  );
  assert.equal(
    testExports.sanitizeVideoPresentationFileBase("   "),
    "video-presentation",
  );
});
