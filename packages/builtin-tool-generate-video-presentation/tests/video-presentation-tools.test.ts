import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildArtifactAssetUrl,
  buildVideoPresentationInitialPayload,
  buildVideoPresentationProjectFileName,
  buildVideoPresentationRequestKey,
  buildVideoPresentationRuntimePromptLines,
  buildVideoPresentationToolResult,
  compactVideoPresentationSourceText,
  estimateNarrationDurationSeconds,
  generateVideoPresentationSchema,
  getSlideDurationSeconds,
  getVideoDurationSeconds,
  parseGenerateVideoPresentationArgs,
  sanitizeVideoPresentationFileBase,
  stripRenderOnlyAudioFields,
  type RenderableVideoPresentationSpec,
} from "../src/index";

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== "string") {
    assert.fail(`${key} must be a string`);
  }
  return value;
}

test("video presentation schema normalizes fields and rejects extras", () => {
  assert.deepEqual(
    parseGenerateVideoPresentationArgs({
      source_content: "  Quarterly update source  ",
      user_prompt: "  Calm executive pacing  ",
      video_title: "  Quarterly Review  ",
    }),
    {
      source_content: "Quarterly update source",
      user_prompt: "Calm executive pacing",
      video_title: "Quarterly Review",
    },
  );
  assert.equal(
    generateVideoPresentationSchema.safeParse({
      source_content: "Quarterly update source.",
      extra: "unexpected",
    }).success,
    false,
  );
  assert.throws(
    () => parseGenerateVideoPresentationArgs({ source_content: "   " }),
    /source_content is required/u,
  );
});

test("video presentation payload, request key, and filenames preserve backend behavior", () => {
  const sourceContent = [
    "# Roadmap",
    "- [Internal launch](https://secret.example/raw)",
    "```json",
    '{"schemaVersion":1}',
    "```",
    "**Keep narration concise.**",
  ].join("\n");

  assert.equal(
    compactVideoPresentationSourceText(sourceContent),
    "Roadmap Internal launch Keep narration concise.",
  );
  assert.equal(
    buildVideoPresentationRequestKey({
      threadId: "thread-1",
      userMessageId: "message-1",
      workspaceId: "workspace-1",
    }),
    "video_presentation:workspace-1:thread-1:message-1",
  );
  assert.equal(
    sanitizeVideoPresentationFileBase("Q4 / Board: Review?"),
    "Q4-Board-Review",
  );
  assert.equal(sanitizeVideoPresentationFileBase("   "), "video-presentation");
  assert.equal(
    buildVideoPresentationProjectFileName("Q4 / Board: Review?"),
    "Q4-Board-Review.video-presentation.json",
  );

  const payload = buildVideoPresentationInitialPayload({
    artifactId: "artifact 1",
    fileName: "Roadmap.video-presentation.json",
    jobId: "video-presentation-render_artifact-1",
    narrationEnabled: false,
    requestKey: "video_presentation:workspace-1:thread-1:message-1",
    sourceContent,
    title: "Roadmap",
    workspaceId: "workspace 1",
  });

  assert.equal(
    payload.prompt,
    "Roadmap Internal launch Keep narration concise.",
  );
  assert.doesNotMatch(readString(payload, "prompt"), /https:\/\/secret/u);
  assert.doesNotMatch(readString(payload, "prompt"), /schemaVersion/u);
  assert.equal(
    payload.artifactUrl,
    "/artifact-preview?artifactId=artifact+1&workspaceId=workspace+1",
  );
});

test("video presentation result and prompt helpers expose browser-render status", () => {
  assert.equal(
    buildVideoPresentationToolResult({
      artifactId: "artifact-1",
      artifactUrl:
        "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
      fileName: "Quarterly-Review.video-presentation.json",
      narrationEnabled: true,
      title: "Quarterly Review",
    }).status,
    "pending",
  );
  assert.equal(
    buildVideoPresentationRuntimePromptLines({
      toolName: "generate_video_presentation",
      videoSelection: { narration: { enabled: false } },
    }).some((line) => line.includes("Narration defaults to off")),
    true,
  );
});

test("video presentation render spec helpers preserve backend behavior", () => {
  const spec: RenderableVideoPresentationSpec = {
    schemaVersion: 1,
    title: "Roadmap",
    fps: 30,
    width: 1920,
    height: 1080,
    narrationEnabled: true,
    theme: {
      background: "#0b1017",
      foreground: "#f8fafc",
      accent: "#38bdf8",
      secondary: "#f59e0b",
      muted: "#94a3b8",
      fontFamily: "Inter, sans-serif",
    },
    slides: [
      {
        slideNumber: 1,
        title: "Roadmap",
        speakerTranscript: ["Launch in three focused phases."],
      },
    ],
    scenes: [
      {
        slideNumber: 1,
        sceneType: "title",
        composition: "cinematic",
        mood: "executive",
        title: "Roadmap",
        bullets: [],
        metrics: [],
        timeline: [],
        motion: {
        camera: "slow-push",
        emphasis: "spotlight",
        entrance: "fade",
        transition: "fade",
      },
      },
    ],
    audioTracks: [
      {
        assetUrl: "/asset.mp3",
        durationSeconds: 7.2,
        fileName: "slide-1.mp3",
        mimeType: "audio/mpeg",
        narration: "Launch in three focused phases.",
        provider: "test",
        providerModel: "tts-test",
        renderSrc: "data:audio/mpeg;base64,abc",
        sizeBytes: 42,
        slideNumber: 1,
        storageKey: "artifact/slide-1.mp3",
      },
    ],
  };

  assert.equal(
    buildArtifactAssetUrl({
      artifactId: "artifact 1",
      fileName: "slide 1.mp3",
      workspaceId: "workspace 1",
    }),
    "/v1/workspaces/workspace%201/artifacts/artifact%201/assets/slide%201.mp3",
  );
  assert.equal(getSlideDurationSeconds(spec, 1), 8.05);
  assert.equal(getVideoDurationSeconds(spec), 8.07);
  assert.equal(
    estimateNarrationDurationSeconds("Launch in three focused phases.") >= 4.5,
    true,
  );
  assert.deepEqual(stripRenderOnlyAudioFields(spec.audioTracks), [
    {
      assetUrl: "/asset.mp3",
      durationSeconds: 7.2,
      fileName: "slide-1.mp3",
      mimeType: "audio/mpeg",
      slideNumber: 1,
      storageKey: "artifact/slide-1.mp3",
    },
  ]);
});
