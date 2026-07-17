import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildArtifactAssetUrl,
  buildVideoPresentationInitialPayload,
  buildVideoPresentationProjectFileName,
  buildVideoPresentationRequestKey,
  buildVideoPresentationRuntimePromptLines,
  buildVideoPresentationToolResult,
  createGenerateVideoPresentationTool,
  generateVideoPresentationSchema,
  parseGenerateVideoPresentationArgs,
  sanitizeVideoPresentationFileBase,
  stripVideoPresentationMarkdown,
} from "../src/index";

const baseRequest = parseGenerateVideoPresentationArgs({
  brief: "生成 video presentation 介绍费曼学习法",
  title: "费曼学习法",
  sourceDigest: "Explain the Feynman learning method.",
  stylePreset: "cinematic",
  durationTarget: "short",
  language: "zh-CN",
  narrationEnabled: true,
});

test("video presentation schema accepts brief-first input", () => {
  const parsed = parseGenerateVideoPresentationArgs(baseRequest);

  assert.equal(parsed.brief, "生成 video presentation 介绍费曼学习法");
  assert.equal(parsed.title, "费曼学习法");
  assert.equal(parsed.stylePreset, "cinematic");
  assert.equal(
    parseGenerateVideoPresentationArgs({
      brief: "Explain Feynman learning",
      audience: "students",
      tone: "clear and practical",
    }).audience,
    "students",
  );
  assert.equal(generateVideoPresentationSchema.safeParse({}).success, true);
  assert.equal(generateVideoPresentationSchema.safeParse(null).success, false);
  assert.equal(
    generateVideoPresentationSchema.safeParse({
      brief: "Explain Feynman learning",
      unknownPlannerField: { ignored: true },
    }).success,
    true,
  );
});

test("video presentation parser normalizes malformed optional fields", () => {
  const parsed = parseGenerateVideoPresentationArgs({
    brief: "Explain spaced repetition",
    stylePreset: "purple-gradient",
    durationTarget: "forever",
    renderProfile: {
      stylePreset: "technical",
      visualDensity: "very dense",
      durationTarget: "short",
      language: "en-US",
    },
    narration: { enabled: "yes" },
    assets: [
      { assetId: "asset-1", role: "hero" },
      { assetId: "", role: "broken" },
      "not-an-asset",
    ],
    regeneration: {
      instruction: "Regenerate scene 2",
      slideNumbers: [2, 99, 3.5, "4"],
    },
    slideCount: "6",
    visualDirection: "chalkboard kinetic diagrams",
    brand: {
      colors: ["#111111", "#f5d76e"],
      typography: "warm editorial sans",
    },
    motion: {
      pacing: "dynamic",
      transitionStyle: "wipe through concept cards",
      animationIntensity: "bold",
    },
    canvas: {
      width: "1280",
      height: 720,
      fps: 24,
    },
  });

  assert.equal(parsed.stylePreset, "technical");
  assert.equal(parsed.durationTarget, "short");
  assert.equal(parsed.renderProfile?.stylePreset, "technical");
  assert.equal(parsed.renderProfile?.durationTarget, "short");
  assert.equal(parsed.renderProfile?.visualDensity, "balanced");
  assert.equal(parsed.narration, undefined);
  assert.equal(parsed.slideCount, 6);
  assert.equal(parsed.visualDirection, "chalkboard kinetic diagrams");
  assert.deepEqual(parsed.brand?.colors, ["#111111", "#f5d76e"]);
  assert.equal(parsed.motion?.pacing, "dynamic");
  assert.equal(parsed.canvas?.width, 1280);
  assert.equal(parsed.canvas?.height, 720);
  assert.equal(parsed.canvas?.fps, 24);
  assert.deepEqual(parsed.assets, [{ assetId: "asset-1", role: "hero" }]);
  assert.deepEqual(parsed.regeneration?.slideNumbers, [2]);
});

test("generate_video_presentation returns input-required for empty brief", async () => {
  const tool = createGenerateVideoPresentationTool(
    {
      teamId: "team-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userId: "user-1",
      userMessageId: "message-1",
    },
    {
      artifacts: {
        createPending: async () => {
          throw new Error("should not create pending artifact");
        },
        findReusable: async () => null,
        findStatus: async () => null,
      },
      queue: {
        enqueueRender: async () => {
          throw new Error("should not enqueue");
        },
      },
      wait: { intervalMs: 1, timeoutMs: 1 },
    },
  );

  const output = await tool.invoke({});
  assert.equal(
    (output as Record<string, unknown>).type,
    "presentation_artifact_input_required",
  );
  assert.equal((output as Record<string, unknown>).status, "needs_content");
});

test("generate_video_presentation waits for ready artifact from brief request", async () => {
  const artifactSnapshots: unknown[] = [
    {
      id: "artifact-1",
      status: "running",
      title: "费曼学习法",
      payloadJson: {
        generation: {
          status: "running",
          stage: "generating_audio_tracks",
          progress: 40,
          attempt: 1,
          maxAttempts: 2,
          retrying: false,
        },
      },
    },
    {
      id: "artifact-1",
      status: "ready",
      title: "费曼学习法",
      payloadJson: {
        artifactUrl:
          "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
        fileName: "Feynman.video-presentation.json",
        generation: { status: "ready", stage: "ready" },
        jobId: "video_presentation_render_artifact-1",
      },
    },
  ];
  const readySnapshot = artifactSnapshots[1];
  const progressEvents: unknown[] = [];
  let enqueuedRequest: unknown = null;
  let enqueuedLlm: unknown = null;
  const tool = createGenerateVideoPresentationTool(
    {
      teamId: "team-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userId: "user-1",
      userMessageId: "message-1",
      llm: {
        profileAlias: "stable-chat-profile",
        modelAlias: "deepseek/deepseek-chat",
        thinking: { mode: "off", enabled: false },
      },
    },
    {
      artifacts: {
        createPending: async () => undefined,
        findReusable: async () => null,
        findStatus: async () =>
          (artifactSnapshots.shift() ?? readySnapshot) as never,
      },
      queue: {
        enqueueRender: async (input) => {
          enqueuedRequest = input.request;
          enqueuedLlm = input.llm;
        },
      },
      wait: { intervalMs: 1, timeoutMs: 100 },
    },
  );

  const output = await tool.invoke(baseRequest, {
    toolCallId: "tool-call-1",
    writer: (event: unknown) => {
      progressEvents.push(event);
    },
  } as never);

  assert.equal(
    (output as Record<string, unknown>).type,
    "video_presentation_artifact_result",
  );
  assert.equal((output as Record<string, unknown>).status, "ready");
  const generatedArtifactId = (output as Record<string, unknown>).artifact_id;
  assert.equal(
    (output as Record<string, unknown>).source_json_url,
    `/v1/workspaces/workspace-1/artifacts/${generatedArtifactId}/source.json`,
  );
  assert.equal(progressEvents.length > 0, true);
  const runningProgress = progressEvents.find(
    (event) =>
      (event as Record<string, unknown>).stage === "generating_audio_tracks",
  ) as Record<string, unknown> | undefined;
  assert.equal(runningProgress?.progress, 40);
  assert.equal(runningProgress?.attempt, 1);
  assert.equal(runningProgress?.max_attempts, 2);
  assert.equal(
    (enqueuedRequest as Record<string, unknown>).brief,
    "生成 video presentation 介绍费曼学习法",
  );
  assert.equal(
    Object.hasOwn(enqueuedRequest as Record<string, unknown>, "brief"),
    true,
  );
  assert.equal(
    Object.hasOwn(
      enqueuedRequest as Record<string, unknown>,
      "presentationBlueprint",
    ),
    false,
  );
  assert.deepEqual(enqueuedLlm, {
    profileAlias: "stable-chat-profile",
    modelAlias: "deepseek/deepseek-chat",
    thinking: { mode: "off", enabled: false },
  });
});

test("generate_video_presentation applies runtime option defaults to brief-only calls", async () => {
  let enqueuedRequest: unknown = null;
  const tool = createGenerateVideoPresentationTool(
    {
      teamId: "team-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userId: "user-1",
      userMessageId: "message-1",
      defaultRequest: {
        slideCount: 5,
        visualDirection: "chalkboard classroom",
        renderProfile: {
          stylePreset: "technical",
          visualDensity: "dense",
          durationTarget: "short",
          language: "zh-CN",
        },
        canvas: {
          fps: 30,
        },
        motion: {
          pacing: "dynamic",
        },
        narration: {
          enabled: false,
        },
      },
    },
    {
      artifacts: {
        createPending: async () => undefined,
        findReusable: async () => null,
        findStatus: async () => ({
          id: "artifact-1",
          status: "ready",
          title: "费曼学习法",
          payloadJson: {
            generation: { status: "ready", stage: "ready" },
          },
        }),
      },
      queue: {
        enqueueRender: async (input) => {
          enqueuedRequest = input.request;
        },
      },
      wait: { intervalMs: 1, timeoutMs: 100 },
    },
  );

  await tool.invoke({ brief: "生成 video presentation 介绍费曼学习法" });

  assert.equal(
    (enqueuedRequest as Record<string, unknown>).brief,
    "生成 video presentation 介绍费曼学习法",
  );
  assert.equal((enqueuedRequest as Record<string, unknown>).slideCount, 5);
  assert.equal(
    (enqueuedRequest as Record<string, unknown>).visualDirection,
    "chalkboard classroom",
  );
  assert.deepEqual((enqueuedRequest as Record<string, unknown>).renderProfile, {
    stylePreset: "technical",
    visualDensity: "dense",
    durationTarget: "short",
    language: "zh-CN",
  });
  assert.deepEqual((enqueuedRequest as Record<string, unknown>).canvas, {
    fps: 30,
  });
  assert.deepEqual((enqueuedRequest as Record<string, unknown>).motion, {
    pacing: "dynamic",
  });
  assert.deepEqual((enqueuedRequest as Record<string, unknown>).narration, {
    enabled: false,
  });
});

test("generate_video_presentation returns a failed artifact result when worker fails", async () => {
  const tool = createGenerateVideoPresentationTool(
    {
      teamId: "team-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userId: "user-1",
      userMessageId: "message-1",
    },
    {
      artifacts: {
        createPending: async () => undefined,
        findReusable: async () => null,
        findStatus: async () => ({
          id: "artifact-1",
          status: "failed",
          title: "费曼学习法",
          payloadJson: {
            generation: {
              status: "failed",
              stage: "failed",
              errorMessage:
                "Generated Remotion project failed render smoke check",
            },
          },
        }),
      },
      queue: {
        enqueueRender: async () => undefined,
      },
      wait: { intervalMs: 1, timeoutMs: 100 },
    },
  );

  assert.equal(tool.returnDirect, true);
  const output = await tool.invoke(baseRequest);
  assert.equal(
    (output as Record<string, unknown>).type,
    "video_presentation_artifact_result",
  );
  assert.equal((output as Record<string, unknown>).status, "failed");
  assert.match(
    String((output as Record<string, unknown>).error),
    /Generated Remotion project failed render smoke check/u,
  );
});

test("generate_video_presentation timeout returns processing result instead of artifact card", async () => {
  const tool = createGenerateVideoPresentationTool(
    {
      teamId: "team-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userId: "user-1",
      userMessageId: "message-1",
    },
    {
      artifacts: {
        createPending: async () => undefined,
        findReusable: async () => null,
        findStatus: async () => ({
          id: "artifact-1",
          status: "running",
          title: "费曼学习法",
          payloadJson: {
            generation: {
              status: "running",
              stage: "generating_project_code",
            },
          },
        }),
      },
      queue: {
        enqueueRender: async () => undefined,
      },
      wait: { intervalMs: 1, timeoutMs: 1 },
    },
  );

  const output = await tool.invoke(baseRequest);
  assert.equal(
    (output as Record<string, unknown>).type,
    "video_presentation_processing_result",
  );
  assert.equal((output as Record<string, unknown>).status, "running");
});

test("video presentation payload, request key, and filenames preserve backend behavior", () => {
  const sourceDigest = [
    "# Roadmap",
    "- [Internal launch](https://secret.example/raw)",
    "```json",
    '{"schemaVersion":2}',
    "```",
    "**Keep narration concise.**",
  ].join("\n");

  assert.equal(
    stripVideoPresentationMarkdown(sourceDigest),
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
    request: {
      brief: "Generate a roadmap video presentation.",
      title: "Roadmap",
      sourceDigest,
      assets: [],
      renderProfile: {
        stylePreset: "cinematic",
        visualDensity: "balanced",
        durationTarget: "medium",
        language: "en-US",
      },
      narration: { enabled: false },
    },
    requestKey: "video_presentation:workspace-1:thread-1:message-1",
    workspaceId: "workspace 1",
  });

  assert.equal(payload.kind, "video_presentation");
  assert.equal(payload.schemaVersion, 2);
  assert.equal(payload.generation.status, "pending");
  assert.equal(payload.project.title, "Roadmap");
  assert.equal(payload.preview.slideCount, 1);
  assert.doesNotMatch(payload.prompt, /https:\/\/secret/u);
  assert.doesNotMatch(payload.prompt, /schemaVersion/u);
  assert.equal(
    payload.artifactUrl,
    "/artifact-preview?artifactId=artifact+1&workspaceId=workspace+1",
  );
});

test("video presentation result and prompt helpers expose brief-first browser-render status", () => {
  assert.equal(
    buildVideoPresentationToolResult({
      artifactId: "artifact-1",
      artifactUrl:
        "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
      fileName: "Quarterly-Review.video-presentation.json",
      narrationEnabled: true,
      sourceJsonUrl:
        "/v1/workspaces/workspace-1/artifacts/artifact-1/source.json",
      status: "ready",
      title: "Quarterly Review",
    }).source_json_url,
    "/v1/workspaces/workspace-1/artifacts/artifact-1/source.json",
  );
  assert.equal(
    buildVideoPresentationToolResult({
      artifactId: "artifact-1",
      artifactUrl:
        "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
      fileName: "Quarterly-Review.video-presentation.json",
      narrationEnabled: true,
      status: "ready",
      title: "Quarterly Review",
    }).status,
    "ready",
  );
  assert.equal(
    buildVideoPresentationRuntimePromptLines({
      toolName: "generate_video_presentation",
      videoSelection: { narration: { enabled: false } },
    }).some((line) => line.includes("brief-first")),
    true,
  );
});

test("artifact asset url helper preserves artifact asset routing", () => {
  assert.equal(
    buildArtifactAssetUrl({
      artifactId: "artifact 1",
      fileName: "slide 1.mp3",
      workspaceId: "workspace 1",
    }),
    "/v1/workspaces/workspace%201/artifacts/artifact%201/assets/slide%201.mp3",
  );
});
