import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

import {
  buildInitialVideoPresentationPipelineSteps,
  videoPresentationProjectPayloadSchema,
  VIDEO_PRESENTATION_NARRATION_TAIL_PADDING_SECONDS,
} from "@sourceweft/contracts/video-presentation";
import {
  createVideoPresentationPipelineDefinition,
  videoPipelineTestExports as testExports,
  type VideoPipelineDeps,
} from "@sourceweft/builtin-tool-video-presentation";
import type { DeliverableJobEnvelope } from "@sourceweft/capability-contracts";
import { probeAudioDurationSeconds } from "../../shared/audio-duration";
import { createDeliverableProcessor } from "./host";
import type { DeliverableArtifactsAdapter } from "./context";

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

type FakeWorkerDeps = {
  artifacts: DeliverableArtifactsAdapter;
  assets?: {
    fetchImage(input: {
      assetId: string;
    }): Promise<{ data: Uint8Array; mimeType: string } | null>;
  };
  image?: {
    generate(input: {
      prompt: string;
      metadata?: Record<string, unknown>;
    }): Promise<{ data: Uint8Array; mimeType: string } | null>;
  };
  llm: VideoPipelineDeps["llm"];
  storage: VideoPipelineDeps["storage"];
  tts: {
    speech(input: {
      metadata: Record<string, unknown>;
      text: string;
    }): Promise<{ audio: Uint8Array; mimeType: string }>;
  };
  sandbox?: {
    runProject(input: {
      payload: unknown;
      request: unknown;
      job: DeliverableJobEnvelope;
    }): Promise<{
      install: { ok: boolean; diagnostics: string[]; stdout?: string; stderr?: string };
      typecheck: { ok: boolean; diagnostics: string[]; stdout?: string; stderr?: string };
      smoke: { ok: boolean; diagnostics: string[]; stdout?: string; stderr?: string };
      stills?: Array<{ slideNumber: number; data: Uint8Array }>;
    }>;
  };
};

// Drives the REAL pipeline definition through the REAL deliverable host with
// the same fake seams the pre-host worker tests used (deps-level fakes).
function createVideoPresentationGenerateProcessor(
  resolveDeps: () => Promise<FakeWorkerDeps> | FakeWorkerDeps,
) {
  return async (job: { data: Record<string, unknown> }) => {
    const deps = await resolveDeps();
    const definition = createVideoPresentationPipelineDefinition({
      ...(deps.sandbox
        ? { runProject: deps.sandbox.runProject.bind(deps.sandbox) as never }
        : {}),
    });
    const processor = createDeliverableProcessor(definition, async () => ({
      ctx: {
        logger: silentLogger,
        llm: deps.llm,
        tts: deps.tts,
        storage: deps.storage,
        audio: {
          probeDurationSeconds: (input) =>
            probeAudioDurationSeconds({
              buffer: Buffer.from(input.buffer),
              mimeType: input.mimeType,
            }),
        },
        sandbox: undefined,
        ...(deps.assets ? { assets: deps.assets } : {}),
        ...(deps.image ? { image: deps.image } : {}),
      },
      artifacts: deps.artifacts,
    }));
    return processor(job as never);
  };
}

type CompleteArtifactCall = Parameters<
  DeliverableArtifactsAdapter["completeArtifact"]
>[0];

const repositoryState = {
  completed: [] as CompleteArtifactCall[],
  failedErrorCode: null as string | null,
  artifactPayload: null as unknown,
  failedPayload: null as unknown,
  jobProgress: [] as Array<Record<string, unknown>>,
  readyPayload: null as unknown,
  runningStages: [] as string[],
  storageUploads: [] as Array<{ contentType: string; key: string }>,
  llmStructuredCalls: 0,
  llmTextCalls: 0,
  ttsCalls: 0,
  visionCalls: 0,
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
    globalVisualDirection:
      "Chalkboard-inspired teaching diagrams with warm amber accents, hand-drawn arrows, and calm deliberate motion.",
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
      stage: "planning_storyboard",
      progress: 0,
      pipelineSteps: buildInitialVideoPresentationPipelineSteps(),
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
    requestKey: "request-key-1",
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
    <AbsoluteFill style={{ background: "#101820", color: "white", opacity }}>
      <SafeArea justify="center">
        <div>${label}</div>
      </SafeArea>
    </AbsoluteFill>
  );
}
`.trim();
}

function buildWavBuffer(input: { sampleRate: number; seconds: number }) {
  const sampleCount = Math.round(input.sampleRate * input.seconds);
  const bytesPerSample = 2;
  const dataSize = sampleCount * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(input.sampleRate, 24);
  buffer.writeUInt32LE(input.sampleRate * bytesPerSample, 28);
  buffer.writeUInt16LE(bytesPerSample, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

function makeDeps(
  input: {
    assetImages?: Record<string, { data: Uint8Array; mimeType: string }>;
    generatedImage?: { data: Uint8Array; mimeType: string };
    llmResponses?: string[];
    structuredError?: Error;
    structuredResponses?: unknown[];
    smokeFails?: boolean;
    stills?: Array<{ slideNumber: number; data: Uint8Array }>;
    ttsAudio?: Buffer;
    ttsMimeType?: string;
    ttsFailAttempts?: number;
    ttsFails?: boolean;
    visionResponses?: string[];
  } = {},
): FakeWorkerDeps {
  const llmResponses = [
    ...(input.llmResponses ?? [
      validSceneCode("LLM_SCENE_ONE"),
      validSceneCode("LLM_SCENE_TWO"),
    ]),
  ];
  const structuredResponses = [
    ...(input.structuredResponses ?? [storyboard(), themeAssignments()]),
  ];

  const visionResponses = [...(input.visionResponses ?? [])];

  return {
    ...(input.assetImages
      ? {
          assets: {
            fetchImage: async ({ assetId }: { assetId: string }) =>
              input.assetImages?.[assetId] ?? null,
          },
        }
      : {}),
    ...(input.generatedImage
      ? {
          image: {
            generate: async () => input.generatedImage ?? null,
          },
        }
      : {}),
    artifacts: {
      find: async () => ({
        payloadJson: repositoryState.artifactPayload,
      }),
      markFailed: async (markInput) => {
        repositoryState.failedErrorCode = markInput.errorCode;
        repositoryState.failedPayload = markInput.payload;
        return true;
      },
      completeArtifact: async (completeInput) => {
        repositoryState.readyPayload = completeInput.payload;
        repositoryState.completed.push(completeInput);
        return { artifactId: completeInput.artifactId, versionId: "version-1" };
      },
      markRunning: async (markInput) => {
        const runningPayload = videoPresentationProjectPayloadSchema.parse(
          markInput.payload,
        );
        const stage = runningPayload.generation.stage;
        if (repositoryState.runningStages.at(-1) !== stage) {
          repositoryState.runningStages.push(stage);
        }
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
      ...(input.visionResponses
        ? {
            completeVision: async () => {
              repositoryState.visionCalls += 1;
              const next = visionResponses.shift();
              if (!next) {
                throw new Error("Unexpected vision LLM call");
              }
              return next;
            },
          }
        : {}),
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
        ...(input.stills ? { stills: input.stills } : {}),
      }),
    },
    storage: {
      buildArtifactStorageKey: ({ artifactId, fileName, workspaceId }) =>
        `workspaces/${workspaceId}/artifacts/${artifactId}/${fileName}`,
      getBucketName: () => "content",
      // Reading back what a stage uploaded: the fake store is the upload log,
      // so a key that was never uploaded reads as absent, exactly as S3 would.
      download: async ({ key }) => {
        const uploaded = repositoryState.storageUploads.find(
          (entry) => entry.key === key,
        );
        return uploaded
          ? { body: new Uint8Array(0), contentType: uploaded.contentType }
          : null;
      },
      upload: async (uploadInput) => {
        repositoryState.storageUploads.push({
          contentType: uploadInput.contentType,
          key: uploadInput.key,
        });
      },
    },
    tts: {
      speech: async () => {
        repositoryState.ttsCalls += 1;
        if (
          input.ttsFails ||
          (typeof input.ttsFailAttempts === "number" &&
            repositoryState.ttsCalls <= input.ttsFailAttempts)
        ) {
          throw new Error("TTS exploded");
        }
        return {
          // The default fixture is real, measurable audio because that is what
          // a working TTS provider returns. It used to be an opaque byte string
          // whose probe failed, which every test then silently ran against — so
          // the default path exercised the estimate fallback rather than the
          // path production takes. There is no estimate fallback now: an
          // unmeasurable buffer fails the run (see the test that asserts it).
          audio: input.ttsAudio ?? buildWavBuffer({ sampleRate: 16_000, seconds: 2 }),
          mimeType: input.ttsMimeType ?? "audio/wav",
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
  repositoryState.completed = [];
  repositoryState.failedErrorCode = null;
  repositoryState.failedPayload = null;
  repositoryState.jobProgress = [];
  repositoryState.readyPayload = null;
  repositoryState.runningStages = [];
  repositoryState.storageUploads = [];
  repositoryState.llmStructuredCalls = 0;
  repositoryState.llmTextCalls = 0;
  repositoryState.ttsCalls = 0;
  repositoryState.visionCalls = 0;
});

test("visual QA repairs severe defects and records findings", async () => {
  const verdicts = JSON.stringify({
    verdicts: [
      {
        slideNumber: 1,
        ok: false,
        issues: [
          {
            type: "text_cutoff",
            severity: "severe",
            description: "Title clipped at the right edge",
          },
        ],
      },
      { slideNumber: 2, ok: true, issues: [] },
    ],
  });
  const processor = createVideoPresentationGenerateProcessor(async () =>
    makeDeps({
      llmResponses: [
        validSceneCode("LLM_SCENE_ONE"),
        validSceneCode("LLM_SCENE_TWO"),
        validSceneCode("REPAIRED_SCENE_ONE"),
      ],
      stills: [
        { slideNumber: 1, data: new Uint8Array([1]) },
        { slideNumber: 2, data: new Uint8Array([2]) },
      ],
      visionResponses: [verdicts],
    }),
  );
  const result = await processor({ data: jobData() } as never);

  assert.equal(result.status, "ready");
  assert.equal(repositoryState.visionCalls, 1);
  const payload = videoPresentationProjectPayloadSchema.parse(
    (repositoryState.readyPayload as Record<string, unknown>).sourceJson,
  );
  const sceneOne = payload.sceneModules.find(
    (scene) => scene.slideNumber === 1,
  );
  assert.ok(sceneOne);
  assert.match(sceneOne.code, /REPAIRED_SCENE_ONE/u);
  assert.equal(sceneOne.compileStatus, "repaired");
  assert.ok(
    sceneOne.layoutWarnings.some((warning) => warning.startsWith("Visual QA")),
  );
  const sceneTwo = payload.sceneModules.find(
    (scene) => scene.slideNumber === 2,
  );
  assert.match(sceneTwo?.code ?? "", /LLM_SCENE_TWO/u);
  assert.equal(sceneTwo?.layoutWarnings.length, 0);
});

test("visual QA degrades to a no-op without stills or vision model", async () => {
  const processor = createVideoPresentationGenerateProcessor(async () =>
    makeDeps(),
  );
  const result = await processor({ data: jobData() } as never);
  assert.equal(result.status, "ready");
  assert.equal(repositoryState.visionCalls, 0);
  assert.ok(repositoryState.runningStages.includes("verifying_visual_quality"));
});

test("narrationBudgetIssues flags off-budget narration for EN and CJK", () => {
  const inBudget = testExports.narrationBudgetIssues({
    slides: [
      {
        slideNumber: 1,
        speakerTranscript: [
          "Explain the idea as if you were teaching a beginner who has never heard of it.",
        ],
      },
    ],
    target: "medium",
  });
  assert.deepEqual(inBudget, []);

  const tooLong = testExports.narrationBudgetIssues({
    slides: [
      {
        slideNumber: 1,
        speakerTranscript: [
          Array.from({ length: 60 }, () => "word").join(" "),
        ],
      },
    ],
    target: "short",
  });
  assert.equal(tooLong.length, 1);
  assert.match(tooLong[0] ?? "", /too long/);

  const cjkInBudget = testExports.narrationBudgetIssues({
    slides: [
      {
        slideNumber: 1,
        speakerTranscript: ["费曼学习法的核心是把复杂概念讲给完全不懂的人听，从而暴露自己理解上的空缺。"],
      },
    ],
    target: "medium",
  });
  assert.deepEqual(cjkInBudget, []);
});

test("uses measured audio duration for scene length with tail padding", async () => {
  const processor = createVideoPresentationGenerateProcessor(async () =>
    makeDeps({
      ttsAudio: buildWavBuffer({ sampleRate: 16_000, seconds: 2.5 }),
      ttsMimeType: "audio/wav",
    }),
  );
  const result = await processor({ data: jobData() } as never);

  assert.equal(result.status, "ready");
  const payload = videoPresentationProjectPayloadSchema.parse(
    (repositoryState.readyPayload as Record<string, unknown>).sourceJson,
  );
  const fps = payload.project.fps;
  for (const track of payload.audioTracks) {
    assert.equal(track.durationSeconds, 2.5);
  }
  for (const scene of payload.sceneModules) {
    const track = payload.audioTracks.find(
      (candidate) => candidate.slideNumber === scene.slideNumber,
    );
    assert.ok(track);
    assert.ok(
      scene.durationInFrames >=
        Math.ceil(
          (track.durationSeconds +
            VIDEO_PRESENTATION_NARRATION_TAIL_PADDING_SECONDS) *
            fps,
        ),
      `slide ${scene.slideNumber}: scene ${scene.durationInFrames} frames must cover narration plus tail padding`,
    );
  }
});

test("the finished video presentation closes through the shared two-phase write", async () => {
  const processor = createVideoPresentationGenerateProcessor(async () =>
    makeDeps({
      stills: [
        { slideNumber: 2, data: new Uint8Array([2]) },
        { slideNumber: 1, data: new Uint8Array([1]) },
      ],
    }),
  );

  await processor({ data: jobData() } as never);

  const completion = repositoryState.completed[0];
  assert.ok(completion);
  // The type is the pipeline's own; the title is the artifact's; the payload is
  // finalize()'s whole result. Nothing here is host knowledge about video.
  assert.equal(completion.artifactType, "video_presentation");
  assert.equal(completion.title, "Feynman Method");
  assert.equal(completion.payload, repositoryState.readyPayload);
  // Create runs own the pending → ready transition, so status alone identifies
  // a duplicate delivery and no version lock is carried.
  assert.deepEqual(completion.expectedStatuses, ["pending", "running"]);
  assert.equal("expectedVersionNo" in completion, false);
  // The cover still is uploaded inside the render stage that produced it, so
  // what reaches the write path is the key, not the bytes.
  assert.match(completion.preview?.storageKey ?? "", /-cover\.jpg$/u);
  assert.equal(completion.preview?.metadata.mimeType, "image/jpeg");
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
    "planning_storyboard",
    "materializing_assets",
    "generating_audio_tracks",
    "assigning_slide_themes",
    "generating_scene_modules",
    "repairing_scene_modules",
    "installing_project",
    "typechecking_project",
    "rendering_smoke_preview",
    "verifying_visual_quality",
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
  // The tool-call idempotency key must survive every worker payload rewrite,
  // or retried tool calls create duplicate artifacts.
  assert.equal(payload.requestKey, "request-key-1");
  assert.equal(repositoryState.storageUploads.length, 2);
  assert.equal(payload.sceneModules.length, 2);
  assert.match(payload.sceneModules[0]?.code ?? "", /LLM_SCENE_ONE/u);
  assert.match(payload.sceneModules[1]?.code ?? "", /LLM_SCENE_TWO/u);
  assert.equal(payload.sceneModules[0]?.compileStatus, "compiled");
  assert.equal(payload.slides.length, 2);
  // request() carries no visualDirection, so the planner-authored direction
  // from the storyboard fixture must win over the generic fallback.
  assert.equal(
    payload.project.globalVisualDirection,
    storyboard().globalVisualDirection,
  );
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

test("processVideoPresentationGenerateJob persists brand and motion customization onto the project", async () => {
  const processor = createVideoPresentationGenerateProcessor(async () =>
    makeDeps(),
  );
  const result = await processor({
    data: {
      ...jobData(),
      request: {
        ...request(),
        brand: { colors: ["#112233"], typography: "Serif" },
        motion: { pacing: "calm" },
      },
    },
  });

  assert.equal(result.status, "ready");
  const payload = videoPresentationProjectPayloadSchema.parse(
    (repositoryState.readyPayload as Record<string, unknown>).sourceJson,
  );
  assert.deepEqual(payload.project.brand?.colors, ["#112233"]);
  assert.equal(payload.project.brand?.typography, "Serif");
  assert.equal(payload.project.motion?.pacing, "calm");
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

test("narration whose duration cannot be measured fails the run, never estimates", async () => {
  // Speech that does not decode. This used to be swallowed: the track was
  // recorded with `estimateNarrationDurationSeconds(transcript)` and
  // `durationSource: "estimated"`, the scene was then cut to fit that guess,
  // and every downstream check compared the guess against a length derived
  // from it — so a short guess shipped a deck with the tail of its speech
  // clipped and nothing to say so. The duration is load-bearing (it sets the
  // scene's frame count), so an unmeasurable buffer is a failure, not a
  // degradation, and it fails here where a stage retry can regenerate the
  // speech rather than in a deliverable nobody can re-derive.
  const processor = createVideoPresentationGenerateProcessor(async () =>
    makeDeps({
      ttsAudio: Buffer.from("not-decodable-audio"),
      ttsMimeType: "audio/mpeg",
    }),
  );

  await assert.rejects(
    () => processor({ data: jobData() } as never),
    /Narration duration could not be measured for slide/u,
  );
  const failedPayload = videoPresentationProjectPayloadSchema.parse(
    repositoryState.failedPayload,
  );
  assert.equal(failedPayload.generation.status, "failed");
  // Nothing was published, and no track carries a made-up number.
  assert.equal(repositoryState.readyPayload, null);
  assert.deepEqual(failedPayload.audioTracks, []);
});

test("processVideoPresentationGenerateJob records stage retry progress for audio", async () => {
  const processor = createVideoPresentationGenerateProcessor(async () =>
    makeDeps({ ttsFails: true }),
  );

  await assert.rejects(
    () => processor({ data: jobData() } as never),
    /TTS exploded/u,
  );

  const retryingPayload = videoPresentationProjectPayloadSchema.parse(
    repositoryState.failedPayload,
  );
  const audioStep = retryingPayload.generation.pipelineSteps?.find(
    (step) => step.id === "generating_audio_tracks",
  );
  assert.equal(audioStep?.status, "failed");
  assert.equal(audioStep?.maxAttempts, 2);
  assert.equal(repositoryState.ttsCalls, 4);
});

test("processVideoPresentationGenerateJob can succeed after a stage retry", async () => {
  const processor = createVideoPresentationGenerateProcessor(async () =>
    makeDeps({ ttsFailAttempts: 1 }),
  );

  const result = await processor({ data: jobData() } as never);

  assert.deepEqual(result, {
    artifactId: "artifact-1",
    status: "ready",
    versionId: "version-1",
  });
  assert.equal(repositoryState.ttsCalls, 4);
  assert.equal(repositoryState.failedPayload, null);
});

test("processVideoPresentationGenerateJob fails when scene repair is exhausted", async () => {
  const processor = createVideoPresentationGenerateProcessor(async () =>
    makeDeps({
      llmResponses: Array.from({ length: 16 }, (_, index) => {
        if (index === 0) {
          return "export default function VideoScene() { return <div>broken</div>; }";
        }
        if (index === 1) {
          return validSceneCode("LLM_SCENE_TWO");
        }
        return "export default function Nope() { return <div />; }";
      }),
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

function readyBasePayload() {
  const track = (slideNumber: number, seconds: number) => ({
    slideNumber,
    assetUrl: `/v1/workspaces/workspace-1/artifacts/artifact-1/assets/slide-${slideNumber}.wav`,
    storageKey: `workspaces/workspace-1/artifacts/artifact-1/base-slide-${slideNumber}.wav`,
    storageBucket: "content",
    durationSeconds: seconds,
    mimeType: "audio/wav",
    fileName: `base-slide-${slideNumber}.wav`,
  });
  const scene = (slideNumber: number, label: string, frames: number) => ({
    slideNumber,
    title: `Scene ${slideNumber}`,
    code: validSceneCode(label),
    componentName: "VideoScene",
    durationInFrames: frames,
    repairAttempts: 0,
    diagnostics: [],
    layoutWarnings: [],
    compileStatus: "compiled",
  });
  return videoPresentationProjectPayloadSchema.parse({
    schemaVersion: 2,
    kind: "video_presentation",
    generation: {
      status: "ready",
      stage: "ready",
      progress: 100,
      checkpointStage: "publishing_video_project",
      pipelineSteps: buildInitialVideoPresentationPipelineSteps().map(
        (step) => ({ ...step, status: "completed", progress: 100 }),
      ),
    },
    project: {
      title: "Feynman Method",
      fps: 30,
      width: 1920,
      height: 1080,
      durationSeconds: 12,
      stylePreset: "cinematic",
      globalVisualDirection: "Cinematic classroom diagrams",
    },
    slides: [
      {
        slideNumber: 1,
        title: "Teach It Simply",
        speakerTranscript: ["Explain it as if teaching a beginner."],
        sceneIntent: "Show the teach-back loop.",
        assetRefs: [],
      },
      {
        slideNumber: 2,
        title: "Find the Gaps",
        speakerTranscript: ["Notice where your explanation breaks."],
        sceneIntent: "Reveal gaps and repair them.",
        assetRefs: [],
      },
    ],
    audioTracks: [track(1, 5), track(2, 4)],
    sceneModules: [
      scene(1, "BASE_SCENE_ONE", 173),
      scene(2, "BASE_SCENE_TWO", 143),
    ],
    assets: [],
    preview: { slideCount: 2, durationSeconds: 12 },
    renderProfile: {
      stylePreset: "cinematic",
      visualDensity: "balanced",
      durationTarget: "short",
      language: "en-US",
    },
    themeAssignments: [
      { slideNumber: 1, themeName: "TERRA", mode: "dark" },
      { slideNumber: 2, themeName: "FROST", mode: "light" },
    ],
    sourceDigest: "Explain the Feynman learning method.",
    requestKey: "request-key-1",
  });
}

function editStoryboardResponse() {
  return {
    slides: [
      {
        slideNumber: 2,
        title: "Close the Gaps",
        subtitle: null,
        contentMarkdown: null,
        speakerTranscript: ["Now close each gap with a simpler explanation."],
        backgroundExplanation: null,
        sceneIntent: "Show gaps being closed one by one.",
        assetNeeds: [],
      },
    ],
  };
}

function editJobData() {
  return {
    ...jobData(),
    jobId: "video_presentation_render_artifact-1__edit_message-2",
    userMessageId: "message-2",
    request: {
      ...request(),
      regeneration: {
        artifactId: "artifact-1",
        instruction: "Rework slide 2 to focus on closing gaps.",
        slideNumbers: [2],
      },
    },
  };
}

test("edit run regenerates only targeted slides and never touches the published version mid-run", async () => {
  repositoryState.artifactPayload = readyBasePayload();
  const processor = createVideoPresentationGenerateProcessor(() =>
    makeDeps({
      structuredResponses: [editStoryboardResponse()],
      llmResponses: [validSceneCode("EDITED_SCENE_TWO")],
      ttsAudio: buildWavBuffer({ sampleRate: 16_000, seconds: 3 }),
      ttsMimeType: "audio/wav",
    }),
  );
  const result = await processor({ data: editJobData() });

  assert.equal(result.status, "ready");
  // Edit mode: no intermediate markRunning writes against the published artifact.
  assert.deepEqual(repositoryState.runningStages, []);
  const payload = videoPresentationProjectPayloadSchema.parse(
    (repositoryState.readyPayload as Record<string, unknown>).sourceJson,
  );
  // Slide 1 untouched: same narration file, same measured duration, same code.
  assert.equal(payload.audioTracks[0]?.fileName, "base-slide-1.wav");
  assert.equal(payload.audioTracks[0]?.durationSeconds, 5);
  assert.match(payload.sceneModules[0]?.code ?? "", /BASE_SCENE_ONE/u);
  assert.equal(payload.sceneModules[0]?.durationInFrames, 173);
  // Slide 2 regenerated: new storyboard entry, new narration, new scene.
  assert.equal(payload.slides[1]?.title, "Close the Gaps");
  assert.equal(payload.audioTracks[1]?.durationSeconds, 3);
  assert.match(payload.sceneModules[1]?.code ?? "", /EDITED_SCENE_TWO/u);
  // Themes reused (no theme LLM call): only the storyboard-edit structured call.
  assert.equal(repositoryState.llmStructuredCalls, 1);
  assert.equal(repositoryState.ttsCalls, 1);
  assert.equal(payload.requestKey, "request-key-1");
});

test("edit failure preserves the published artifact untouched", async () => {
  repositoryState.artifactPayload = readyBasePayload();
  const processor = createVideoPresentationGenerateProcessor(() =>
    makeDeps({
      structuredError: new Error("provider exploded"),
    }),
  );
  await assert.rejects(processor({ data: editJobData() }));
  assert.equal(repositoryState.failedErrorCode, null);
  assert.equal(repositoryState.readyPayload, null);
  assert.deepEqual(repositoryState.runningStages, []);
});

test("provided image assets are materialized and offered to scenes", async () => {
  const processor = createVideoPresentationGenerateProcessor(() =>
    makeDeps({
      assetImages: {
        "img-1": { data: new Uint8Array([137, 80, 78, 71]), mimeType: "image/png" },
      },
    }),
  );
  const data = jobData();
  const result = await processor({
    data: {
      ...data,
      request: {
        ...request(),
        assets: [{ assetId: "img-1", role: "diagrammatic_visual" }],
      },
    },
  });

  assert.equal(result.status, "ready");
  const payload = videoPresentationProjectPayloadSchema.parse(
    (repositoryState.readyPayload as Record<string, unknown>).sourceJson,
  );
  const materialized = payload.assets.find(
    (asset) => asset.assetId === "img-1",
  );
  assert.ok(materialized, "asset should be planned into the payload");
  assert.match(materialized.sourceUrl ?? "", /\/assets\/asset-img-1\.png$/u);
  assert.match(materialized.storageKey, /asset-img-1\.png$/u);
  assert.ok(
    repositoryState.storageUploads.some(
      (upload) =>
        upload.contentType === "image/png" &&
        upload.key.endsWith("asset-img-1.png"),
    ),
    "image bytes should be uploaded into the artifact namespace",
  );
});

test("uncovered assetNeeds are filled with generated imagery when an image model exists", async () => {
  const processor = createVideoPresentationGenerateProcessor(() =>
    makeDeps({
      generatedImage: {
        data: new Uint8Array([255, 216, 255]),
        mimeType: "image/jpeg",
      },
    }),
  );
  const result = await processor({ data: jobData() });

  assert.equal(result.status, "ready");
  const payload = videoPresentationProjectPayloadSchema.parse(
    (repositoryState.readyPayload as Record<string, unknown>).sourceJson,
  );
  // storyboard() slide 1 declares assetNeeds ["diagrammatic_visual"] with no
  // provided asset covering it.
  const generated = payload.assets.find(
    (asset) => asset.assetId === "generated-1-diagrammatic_visual",
  );
  assert.ok(generated, "generated asset should exist");
  assert.equal(generated.source, "generated");
  assert.match(generated.sourceUrl ?? "", /\/assets\/asset-generated-1-diagrammatic_visual\.jpg$/u);
  const slideOne = payload.slides.find((slide) => slide.slideNumber === 1);
  assert.ok(
    slideOne?.assetRefs.some(
      (assetRef) => assetRef.assetId === "generated-1-diagrammatic_visual",
    ),
    "slide should reference the generated asset",
  );
});
