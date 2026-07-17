import assert from "node:assert/strict";
import { beforeEach, test } from "vitest";
import { videoPresentationProjectPayloadSchema } from "@sourceweft/contracts/video-presentation";
import {
  createVideoPresentationGenerateProcessor,
  type VideoPresentationWorkerDeps,
} from "./video-presentation";

const repositoryState = {
  failedErrorCode: null as string | null,
  artifactPayload: null as unknown,
  failedPayload: null as unknown,
  jobProgress: [] as Array<Record<string, unknown>>,
  readyPayload: null as unknown,
  runningStages: [] as string[],
  storageUploads: [] as Array<{ contentType: string; key: string }>,
  llmStructuredCalls: 0,
  llmTextCalls: 0,
};

function request(
  input: { narrationEnabled?: boolean; slideCount?: number } = {},
) {
  return {
    brief: "生成 video presentation 介绍费曼学习法",
    title: "Feynman Method",
    sourceDigest: "Explain the Feynman learning method.",
    stylePreset: "cinematic",
    durationTarget: "short",
    language: "en-US",
    narrationEnabled: input.narrationEnabled ?? true,
    slideCount: input.slideCount ?? 2,
  } as const;
}

function storyboard() {
  return {
    slides: [
      {
        slideNumber: 1,
        title: "Teach It Simply",
        subtitle: null,
        contentMarkdown: "Explain the idea in plain language.",
        speakerTranscript: ["Explain it as if teaching a beginner."],
        backgroundExplanation: null,
        sceneIntent: "Show the teach-back loop.",
        assetNeeds: ["diagrammatic_visual"],
      },
      {
        slideNumber: 2,
        title: "Find the Gaps",
        subtitle: null,
        contentMarkdown: null,
        speakerTranscript: ["Notice where your explanation breaks."],
        backgroundExplanation: null,
        sceneIntent: "Reveal gaps and repair them.",
        assetNeeds: [],
      },
    ],
  };
}

function themeAssignments() {
  return {
    assignments: [
      { slideNumber: 1, themeName: "TERRA", mode: "dark" },
      { slideNumber: 2, themeName: "FROST", mode: "light" },
    ],
  };
}

function initialPayload() {
  const createRequest = request();
  return videoPresentationProjectPayloadSchema.parse({
    schemaVersion: 2,
    kind: "video_presentation",
    generation: {
      status: "pending",
      stage: "planning",
      progress: 0,
    },
    project: {
      title: createRequest.title,
      fps: 30,
      width: 1920,
      height: 1080,
      durationSeconds: 0,
      stylePreset: "cinematic",
      globalVisualDirection: "Cinematic classroom diagrams",
    },
    slides: [
      {
        slideNumber: 1,
        title: createRequest.title,
        contentMarkdown: createRequest.brief,
        speakerTranscript: [createRequest.brief],
        sceneIntent: "Introduce the requested video presentation topic.",
        assetRefs: [],
      },
    ],
    audioTracks: [],
    sceneModules: [],
    assets: [],
    preview: {
      slideCount: 1,
      durationSeconds: 0,
    },
    renderProfile: {
      stylePreset: "cinematic",
      visualDensity: "balanced",
      durationTarget: "short",
      language: "en-US",
    },
    themeAssignments: [],
    sourceDigest: createRequest.sourceDigest,
  });
}

function validSceneCode(label: string) {
  return `
import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

export default function VideoScene() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const opacity = interpolate(frame, [0, fps], [0, 1], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ background: "#101820", color: "white", opacity, padding: 96 }}>
      <div>${label}</div>
    </AbsoluteFill>
  );
}
`.trim();
}

function makeDeps(
  input: {
    llmResponses?: string[];
    structuredError?: Error;
    structuredResponses?: unknown[];
    smokeFails?: boolean;
    ttsFails?: boolean;
  } = {},
): VideoPresentationWorkerDeps {
  const llmResponses = [
    ...(input.llmResponses ?? [
      validSceneCode("LLM_SCENE_ONE"),
      validSceneCode("LLM_SCENE_TWO"),
    ]),
  ];
  const structuredResponses = [
    ...(input.structuredResponses ?? [storyboard(), themeAssignments()]),
  ];

  return {
    artifacts: {
      find: async () => ({
        payloadJson: repositoryState.artifactPayload,
      }),
      markFailed: async (markInput) => {
        repositoryState.failedErrorCode = markInput.errorCode;
        repositoryState.failedPayload = markInput.payload;
        return true;
      },
      markReady: async (markInput) => {
        repositoryState.readyPayload = markInput.payload;
        return { artifactId: markInput.artifactId, versionId: "version-1" };
      },
      markRunning: async (markInput) => {
        const runningPayload = videoPresentationProjectPayloadSchema.parse(
          markInput.payload,
        );
        repositoryState.runningStages.push(runningPayload.generation.stage);
        repositoryState.artifactPayload = markInput.payload;
        return true;
      },
    },
    llm: {
      complete: async () => {
        repositoryState.llmTextCalls += 1;
        const next = llmResponses.shift();
        if (!next) {
          throw new Error("Unexpected LLM call");
        }
        return next;
      },
      completeStructured: async () => {
        repositoryState.llmStructuredCalls += 1;
        if (input.structuredError) {
          throw input.structuredError;
        }
        const next = structuredResponses.shift();
        if (!next) {
          throw new Error("Unexpected structured LLM call");
        }
        return next;
      },
    },
    sandbox: {
      runProject: async () => ({
        install: {
          ok: true,
          diagnostics: [],
          stdout: "install-ok",
        },
        typecheck: {
          ok: true,
          diagnostics: [],
          stdout: "typecheck-ok",
        },
        smoke: input.smokeFails
          ? {
              ok: false,
              diagnostics: ["first frame was blank"],
              stderr: "blank frame",
            }
          : {
              ok: true,
              diagnostics: [],
              stdout: "render-smoke-ok",
            },
      }),
    },
    storage: {
      buildArtifactStorageKey: ({ artifactId, fileName, workspaceId }) =>
        `workspaces/${workspaceId}/artifacts/${artifactId}/${fileName}`,
      getBucketName: () => "content",
      upload: async (uploadInput) => {
        repositoryState.storageUploads.push({
          contentType: uploadInput.contentType,
          key: uploadInput.key,
        });
      },
    },
    tts: {
      speech: async () => {
        if (input.ttsFails) {
          throw new Error("TTS exploded");
        }
        return {
          audio: Buffer.from("real-audio-bytes"),
          mimeType: "audio/mpeg",
        };
      },
    },
  };
}

function jobData(
  input: { narrationEnabled?: boolean; slideCount?: number } = {},
) {
  return {
    artifactId: "artifact-1",
    jobId: "video-presentation-render_artifact-1",
    requestKey: "request-1",
    teamId: "team-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    userId: "user-1",
    userMessageId: "message-1",
    title: "Feynman Method",
    request: request(input),
    narrationEnabled: input.narrationEnabled ?? true,
  };
}

function job(
  input: {
    attempts?: number;
    attemptsMade?: number;
    narrationEnabled?: boolean;
    slideCount?: number;
  } = {},
) {
  return {
    attemptsMade: input.attemptsMade ?? 0,
    data: jobData(input),
    opts: { attempts: input.attempts ?? 1 },
    updateProgress: async (progress: Record<string, unknown>) => {
      repositoryState.jobProgress.push(progress);
    },
  } as never;
}

beforeEach(() => {
  repositoryState.artifactPayload = initialPayload();
  repositoryState.failedErrorCode = null;
  repositoryState.failedPayload = null;
  repositoryState.jobProgress = [];
  repositoryState.readyPayload = null;
  repositoryState.runningStages = [];
  repositoryState.storageUploads = [];
  repositoryState.llmStructuredCalls = 0;
  repositoryState.llmTextCalls = 0;
});

test("processVideoPresentationGenerateJob plans internally and publishes code-first project", async () => {
  const processor = createVideoPresentationGenerateProcessor(async () =>
    makeDeps(),
  );
  const result = await processor({ data: jobData() } as never);

  assert.deepEqual(result, {
    artifactId: "artifact-1",
    status: "ready",
    versionId: "version-1",
  });
  assert.deepEqual(repositoryState.runningStages, [
    "generating_project_code",
    "planning_storyboard",
    "materializing_assets",
    "generating_audio_tracks",
    "assigning_slide_themes",
    "generating_scene_modules",
    "repairing_scene_modules",
    "installing_project",
    "typechecking_project",
    "rendering_smoke_preview",
    "publishing_video_project",
  ]);
  const payload = videoPresentationProjectPayloadSchema.parse(
    (repositoryState.readyPayload as Record<string, unknown>).sourceJson,
  );
  const readyPayload = repositoryState.readyPayload as Record<string, unknown>;
  assert.equal(payload.generation.status, "ready");
  assert.equal(
    readyPayload.sourceJsonUrl,
    "/v1/workspaces/workspace-1/artifacts/artifact-1/source.json",
  );
  assert.equal(readyPayload.sourceJsonFileName, "Feynman-Method.source.json");
  assert.equal(payload.audioTracks.length, 2);
  assert.equal(payload.audioTracks[0]?.storageBucket, "content");
  assert.match(payload.audioTracks[0]?.assetUrl ?? "", /\/assets\//);
  assert.equal(repositoryState.storageUploads.length, 2);
  assert.equal(payload.sceneModules.length, 2);
  assert.match(payload.sceneModules[0]?.code ?? "", /LLM_SCENE_ONE/u);
  assert.match(payload.sceneModules[1]?.code ?? "", /LLM_SCENE_TWO/u);
  assert.equal(payload.sceneModules[0]?.compileStatus, "compiled");
  assert.equal(payload.slides.length, 2);
  assert.equal(payload.themeAssignments.length, 2);
  assert.equal(repositoryState.llmStructuredCalls, 2);
  assert.equal(repositoryState.llmTextCalls, 2);
  assert.equal(payload.projectCode?.install.ok, true);
  assert.equal(payload.projectCode?.typecheck.ok, true);
  assert.equal(payload.projectCode?.smoke.ok, true);
  assert.match(
    payload.projectCode?.files.find(
      (file) => file.path === "src/scenes/Slide1.tsx",
    )?.content ?? "",
    /@ts-nocheck/u,
  );
  assert.equal(
    payload.preview.durationSeconds,
    payload.project.durationSeconds,
  );
});

test("processVideoPresentationGenerateJob fails visibly when theme output is invalid", async () => {
  const processor = createVideoPresentationGenerateProcessor(async () =>
    makeDeps({
      structuredResponses: [
        storyboard(),
        {
          assignments: [
            { slideNumber: 1, themeName: "NOT_A_THEME", mode: "dark" },
            { slideNumber: 2, themeName: "FROST", mode: "light" },
          ],
        },
      ],
    }),
  );

  await assert.rejects(
    () => processor(job()),
    /VIDEO_PRESENTATION_THEME_ASSIGNMENT_FAILED.*invalid structured content/u,
  );
  const failedPayload = videoPresentationProjectPayloadSchema.parse(
    repositoryState.failedPayload,
  );
  assert.equal(
    failedPayload.generation.errorCode,
    "VIDEO_PRESENTATION_THEME_ASSIGNMENT_FAILED",
  );
  assert.equal(repositoryState.readyPayload, null);
});

test("processVideoPresentationGenerateJob fails visibly when storyboard output is invalid", async () => {
  const processor = createVideoPresentationGenerateProcessor(async () =>
    makeDeps({
      structuredResponses: [storyboard()],
    }),
  );

  await assert.rejects(
    () => processor(job({ slideCount: 5 })),
    /VIDEO_PRESENTATION_STORYBOARD_GENERATION_FAILED.*slides 1-5/u,
  );
  const failedPayload = videoPresentationProjectPayloadSchema.parse(
    repositoryState.failedPayload,
  );
  assert.equal(
    failedPayload.generation.errorCode,
    "VIDEO_PRESENTATION_STORYBOARD_GENERATION_FAILED",
  );
  assert.equal(repositoryState.readyPayload, null);
});

test("processVideoPresentationGenerateJob rejects duplicate storyboard slide numbers", async () => {
  const duplicateStoryboard = storyboard();
  duplicateStoryboard.slides[1]!.slideNumber = 1;
  const processor = createVideoPresentationGenerateProcessor(async () =>
    makeDeps({ structuredResponses: [duplicateStoryboard] }),
  );

  await assert.rejects(
    () => processor(job()),
    /VIDEO_PRESENTATION_STORYBOARD_GENERATION_FAILED.*slides 1-2/u,
  );
  assert.equal(repositoryState.llmStructuredCalls, 1);
  assert.equal(repositoryState.readyPayload, null);
});

test("processVideoPresentationGenerateJob rejects missing theme assignments", async () => {
  const processor = createVideoPresentationGenerateProcessor(async () =>
    makeDeps({
      structuredResponses: [
        storyboard(),
        {
          assignments: [{ slideNumber: 1, themeName: "TERRA", mode: "dark" }],
        },
      ],
    }),
  );

  await assert.rejects(
    () => processor(job()),
    /VIDEO_PRESENTATION_THEME_ASSIGNMENT_FAILED.*invalid structured content/u,
  );
  assert.equal(repositoryState.llmStructuredCalls, 2);
  assert.equal(repositoryState.readyPayload, null);
});

test("processVideoPresentationGenerateJob does not retry structured provider errors", async () => {
  const processor = createVideoPresentationGenerateProcessor(async () =>
    makeDeps({ structuredError: new Error("provider unavailable") }),
  );

  await assert.rejects(
    () => processor(job()),
    /Storyboard provider call failed: provider unavailable/u,
  );
  assert.equal(repositoryState.llmStructuredCalls, 1);
  assert.equal(repositoryState.readyPayload, null);
});

test("processVideoPresentationGenerateJob repairs invalid scene code with LLM output", async () => {
  const processor = createVideoPresentationGenerateProcessor(async () =>
    makeDeps({
      llmResponses: [
        "export default function VideoScene() { return <div>broken</div>; }",
        validSceneCode("LLM_SCENE_TWO"),
        validSceneCode("REPAIRED_SCENE_ONE"),
      ],
    }),
  );

  await processor({ data: jobData() } as never);
  const payload = videoPresentationProjectPayloadSchema.parse(
    (repositoryState.readyPayload as Record<string, unknown>).sourceJson,
  );
  assert.equal(payload.sceneModules[0]?.compileStatus, "repaired");
  assert.equal(payload.sceneModules[0]?.repairAttempts, 1);
  assert.match(payload.sceneModules[0]?.code ?? "", /REPAIRED_SCENE_ONE/u);
});

test("processVideoPresentationGenerateJob extracts fenced scene code before validation", async () => {
  const processor = createVideoPresentationGenerateProcessor(async () =>
    makeDeps({
      llmResponses: [
        [
          "Here is the component:",
          "```tsx",
          validSceneCode("FENCED_SCENE_ONE"),
          "```",
        ].join("\n"),
        validSceneCode("LLM_SCENE_TWO"),
      ],
    }),
  );

  await processor({ data: jobData() } as never);
  const payload = videoPresentationProjectPayloadSchema.parse(
    (repositoryState.readyPayload as Record<string, unknown>).sourceJson,
  );
  assert.equal(payload.sceneModules[0]?.compileStatus, "compiled");
  assert.match(payload.sceneModules[0]?.code ?? "", /FENCED_SCENE_ONE/u);
  assert.doesNotMatch(payload.sceneModules[0]?.code ?? "", /```/u);
  assert.doesNotMatch(payload.sceneModules[0]?.code ?? "", /Here is/u);
});

test("processVideoPresentationGenerateJob fails artifact when TTS fails", async () => {
  const processor = createVideoPresentationGenerateProcessor(async () =>
    makeDeps({ ttsFails: true }),
  );

  await assert.rejects(
    () => processor({ data: jobData() } as never),
    /TTS exploded/u,
  );
  const failedPayload = videoPresentationProjectPayloadSchema.parse(
    repositoryState.failedPayload,
  );
  assert.equal(failedPayload.generation.status, "failed");
  assert.equal(failedPayload.generation.stage, "failed");
  assert.match(failedPayload.generation.errorMessage ?? "", /TTS exploded/u);
  assert.equal(repositoryState.readyPayload, null);
});

test("processVideoPresentationGenerateJob keeps artifact running before a retry", async () => {
  const processor = createVideoPresentationGenerateProcessor(async () =>
    makeDeps({ ttsFails: true }),
  );

  await assert.rejects(
    () => processor(job({ attempts: 2, attemptsMade: 0 })),
    /TTS exploded/u,
  );

  assert.equal(repositoryState.failedPayload, null);
  const retryingPayload = videoPresentationProjectPayloadSchema.parse(
    repositoryState.artifactPayload,
  );
  assert.equal(retryingPayload.generation.status, "running");
  assert.equal(retryingPayload.generation.retrying, true);
  assert.equal(retryingPayload.generation.attempt, 1);
  assert.equal(retryingPayload.generation.maxAttempts, 2);
  assert.equal(repositoryState.jobProgress.at(-1)?.retrying, true);
});

test("processVideoPresentationGenerateJob can succeed on a later attempt", async () => {
  let dependencyAttempt = 0;
  const processor = createVideoPresentationGenerateProcessor(async () => {
    dependencyAttempt += 1;
    return makeDeps({ ttsFails: dependencyAttempt === 1 });
  });

  await assert.rejects(
    () => processor(job({ attempts: 2, attemptsMade: 0 })),
    /TTS exploded/u,
  );
  const result = await processor(job({ attempts: 2, attemptsMade: 1 }));

  assert.deepEqual(result, {
    artifactId: "artifact-1",
    status: "ready",
    versionId: "version-1",
  });
  assert.equal(repositoryState.failedPayload, null);
  const readyPayload = repositoryState.readyPayload as Record<string, unknown>;
  const sourceJson = videoPresentationProjectPayloadSchema.parse(
    readyPayload.sourceJson,
  );
  assert.equal(sourceJson.generation.attempt, 2);
  assert.equal(sourceJson.generation.maxAttempts, 2);
  assert.equal(sourceJson.generation.retrying, false);
});

test("processVideoPresentationGenerateJob fails when scene repair is exhausted", async () => {
  const processor = createVideoPresentationGenerateProcessor(async () =>
    makeDeps({
      llmResponses: [
        "export default function VideoScene() { return <div>broken</div>; }",
        validSceneCode("LLM_SCENE_TWO"),
        "export default function Nope() { return <div />; }",
        "export default function Nope() { return <div />; }",
        "export default function Nope() { return <div />; }",
      ],
    }),
  );

  await assert.rejects(
    () => processor({ data: jobData() } as never),
    /Scene 1 failed validation after repair/u,
  );
  const failedPayload = videoPresentationProjectPayloadSchema.parse(
    repositoryState.failedPayload,
  );
  assert.equal(failedPayload.generation.status, "failed");
  assert.match(failedPayload.generation.errorMessage ?? "", /Scene 1/u);
});

test("processVideoPresentationGenerateJob fails with smoke diagnostics when render smoke fails", async () => {
  const processor = createVideoPresentationGenerateProcessor(async () =>
    makeDeps({ smokeFails: true }),
  );

  await assert.rejects(
    () => processor({ data: jobData() } as never),
    /render smoke check/u,
  );
  const failedPayload = videoPresentationProjectPayloadSchema.parse(
    repositoryState.failedPayload,
  );
  assert.equal(failedPayload.projectCode?.smoke.ok, false);
  assert.match(
    failedPayload.generation.errorMessage ?? "",
    /first frame was blank/u,
  );
});

test("processVideoPresentationGenerateJob fails with a coded error when sandbox is unavailable", async () => {
  const deps = makeDeps();
  delete deps.sandbox;
  const processor = createVideoPresentationGenerateProcessor(async () => deps);

  await assert.rejects(
    () => processor({ data: jobData() } as never),
    /VIDEO_PRESENTATION_SANDBOX_UNAVAILABLE/u,
  );

  const failedPayload = videoPresentationProjectPayloadSchema.parse(
    repositoryState.failedPayload,
  );
  assert.equal(
    failedPayload.generation.errorCode,
    "VIDEO_PRESENTATION_SANDBOX_UNAVAILABLE",
  );
  assert.equal(
    repositoryState.failedErrorCode,
    "VIDEO_PRESENTATION_SANDBOX_UNAVAILABLE",
  );
  assert.equal(repositoryState.readyPayload, null);
});

test("processVideoPresentationGenerateJob persists configured sandbox execution failures", async () => {
  const deps = makeDeps();
  deps.sandbox = {
    runProject: async () => {
      throw new Error("Daytona execution failed");
    },
  };
  const processor = createVideoPresentationGenerateProcessor(async () => deps);

  await assert.rejects(
    () => processor({ data: jobData() } as never),
    /VIDEO_PRESENTATION_SANDBOX_EXECUTION_FAILED.*Daytona execution failed/u,
  );

  const failedPayload = videoPresentationProjectPayloadSchema.parse(
    repositoryState.failedPayload,
  );
  assert.equal(
    failedPayload.generation.errorCode,
    "VIDEO_PRESENTATION_SANDBOX_EXECUTION_FAILED",
  );
  assert.equal(
    repositoryState.failedErrorCode,
    "VIDEO_PRESENTATION_SANDBOX_EXECUTION_FAILED",
  );
  assert.match(
    failedPayload.generation.errorMessage ?? "",
    /Daytona execution failed/u,
  );
  assert.equal(repositoryState.readyPayload, null);
});

test("processVideoPresentationGenerateJob skips audio generation when narration is disabled", async () => {
  const processor = createVideoPresentationGenerateProcessor(async () =>
    makeDeps(),
  );

  await processor({ data: jobData({ narrationEnabled: false }) } as never);
  const payload = videoPresentationProjectPayloadSchema.parse(
    (repositoryState.readyPayload as Record<string, unknown>).sourceJson,
  );
  assert.equal(payload.audioTracks.length, 0);
  assert.equal(repositoryState.storageUploads.length, 0);
  assert.ok(
    payload.sceneModules.every((scene) => scene.durationInFrames >= 60),
  );
});
