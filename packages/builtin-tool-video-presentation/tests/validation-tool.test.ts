import assert from "node:assert/strict";
import test from "node:test";
import {
  VIDEO_PRESENTATION_WORKFLOW_VERSION,
  videoPresentationDraftPayloadSchema,
} from "@sourceweft/contracts/video-presentation";
import { withAgentToolHostInvocationSignal } from "@sourceweft/contracts/agent-tools";
import { createValidateVideoPresentationTool } from "../src/agent/validation-tool";
import {
  VIDEO_PRESENTATION_BUILDER_VERSION,
  sha256Digest,
} from "../src/agent/common";
import {
  VIDEO_PRESENTATION_RENDER_POLICY,
  VideoPresentationRenderError,
  type VideoPresentationRenderPort,
} from "../src/agent/render-port";
import {
  buildVideoValidationInputDigest,
  VIDEO_PRESENTATION_VALIDATION_RECEIPT_SCHEMA_VERSION,
  VIDEO_PRESENTATION_VALIDATOR_VERSION,
} from "../src/agent/validation-identity";

const renderedVideoBytes = new Uint8Array([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]);

function successfulRenderPort(
  events: string[] = [],
): VideoPresentationRenderPort {
  return {
    async prepare(input) {
      events.push("prepare");
      let samplesRendered = false;
      return {
        async renderSamples() {
          events.push("samples");
          samplesRendered = true;
          return input.samples.map((sample) => ({
            ...sample,
            data: new Uint8Array([0xff, 0xd8, sample.slideNumber, 0xff, 0xd9]),
            mimeType: "image/jpeg" as const,
          }));
        },
        async renderFinal() {
          assert.equal(samplesRendered, true);
          events.push("final");
          return {
            bytes: renderedVideoBytes,
            report: {
              byteLength: renderedVideoBytes.byteLength,
              contentDigest: sha256Digest(renderedVideoBytes),
              durationInFrames: input.project.durationInFrames,
              fps: input.project.fps,
              width: input.project.width,
              height: input.project.height,
              hasAudio: input.project.narrationEnabled,
              mimeType: "video/mp4" as const,
              renderPolicyVersion: VIDEO_PRESENTATION_RENDER_POLICY.version,
              rendererVersion: VIDEO_PRESENTATION_RENDER_POLICY.rendererVersion,
            },
            timings: {
              prepareMs: 1,
              samplesMs: 1,
              scenesMs: 1,
              audioMs: 1,
              muxMs: 1,
              probeMs: 1,
              downloadMs: 1,
              totalMs: 7,
            },
          };
        },
        async dispose() {
          events.push("dispose");
        },
      };
    },
  };
}

function failingFinalRenderPort(): VideoPresentationRenderPort {
  const base = successfulRenderPort();
  return {
    async prepare(input) {
      const session = await base.prepare(input);
      return {
        ...session,
        async renderFinal() {
          throw new VideoPresentationRenderError(
            "VIDEO_RENDER_COMMAND_FAILED",
            "scene",
            "scene render failed",
          );
        },
      };
    },
  };
}

function draft() {
  return {
    schemaVersion: 1,
    kind: "video_presentation_draft",
    workflowVersion: VIDEO_PRESENTATION_WORKFLOW_VERSION,
    builderVersion: VIDEO_PRESENTATION_BUILDER_VERSION,
    narrationPolicy: { enabled: false },
    renderProfile: {
      stylePreset: "technical",
      visualDensity: "balanced",
      durationTarget: "short",
      language: "en",
    },
    sourceDigest: "source",
    project: {
      title: "Validated video",
      fps: 30,
      width: 1920,
      height: 1080,
      durationSeconds: 5,
      stylePreset: "technical",
      globalVisualDirection: "Clear diagrams",
    },
    slides: [
      {
        slideNumber: 1,
        title: "One",
        speakerTranscript: ["One"],
        sceneIntent: "Show one",
        assetRefs: [],
        assetNeeds: [],
      },
    ],
    sceneModules: [
      {
        slideNumber: 1,
        title: "One",
        code: "export default function VideoScene(){ const frame = useCurrentFrame(); return <AbsoluteFill><SafeArea><div>{frame}</div></SafeArea></AbsoluteFill>; }",
        componentName: "VideoScene",
        durationInFrames: 150,
        diagnostics: [],
        layoutWarnings: [],
        compileStatus: "compiled",
      },
    ],
    audioTracks: [],
    assets: [],
    themeAssignments: [],
  };
}

test("validation passes only after samples, vision, cover, and final MP4 receipt", async () => {
  const commands: string[] = [];
  const renderEvents: string[] = [];
  const receipts: Array<Record<string, unknown>> = [];
  const visionRequests: Array<Record<string, unknown>> = [];
  const value = draft();
  value.project.title = "黑洞：宇宙的终极谜题";
  const sourceBytes = new TextEncoder().encode(JSON.stringify(value));
  const validationTool = createValidateVideoPresentationTool({
    renderPort: successfulRenderPort(renderEvents),
    profile: {
      gatewayConfigId: "vision-gateway",
      profileAlias: "vision-default",
      modelAlias: "vision-model",
    },
    services: {
      media: {
        probeAudioDurationSeconds: async () => null,
      },
      operationCache: {
        claimMany: async (input) => ({
          kind: "claimed",
          items: [
            {
              semanticKey: input.semanticKeys[0]!,
              action: "execute",
              claimToken: "validation-claim",
            },
          ],
        }),
        complete: async () => ({ observationId: "validation-observation" }),
        markUnknown: async () => undefined,
      },
      receipts: {
        issueCurrentRunReceipt: async (input) => {
          receipts.push(input);
          return { receiptId: "validation-receipt" };
        },
        resolveCurrentRunReceipt: async () => null,
      },
      sandbox: {
        allowedReadRoots: ["/workspace"],
        ensureCurrentSession: async () => ({ sessionGeneration: "session" }),
        uploadCurrentFiles: async () => undefined,
        listCurrentFiles: async () => [],
        downloadCurrentFile: async () => new Uint8Array([0xff, 0xd8, 0xff]),
        executeCurrent: async (input) => {
          commands.push(input.command);
          return { exitCode: 0, output: "ok" };
        },
        captureCurrentTree: async () => [
          {
            relativePath: "video-presentation.draft.json",
            bytes: sourceBytes,
          },
        ],
      },
      workBlobs: {
        putIfAbsent: async (input) => ({
          blobRef:
            input.contentType === "video/mp4" ? "video-wip" : "cover-wip",
          contentDigest: input.contentDigest,
        }),
        getVerified: async () => null,
        getBySemanticKey: async () => null,
        deleteScope: async () => undefined,
      },
      modelGateway: {
        getClient: async () =>
          ({
            chat: {
              complete: async (request: Record<string, unknown>) => {
                visionRequests.push(request);
                assert.equal(request.fallbackPolicy, "none");
                return {
                  model: "vision-model",
                  raw: {
                    content: JSON.stringify({
                      verdicts: [{ slideNumber: 1, ok: true, issues: [] }],
                    }),
                  },
                };
              },
            },
          }) as never,
      },
    },
  });

  const output = (await validationTool.invoke(
    {
      projectRoot: "/workspace/video",
      sourceJsonPath: "/workspace/video/video-presentation.draft.json",
    },
    { toolCallId: "validation-call" } as never,
  )) as Record<string, unknown>;

  assert.equal(output.status, "passed");
  assert.equal(output.validationReceiptId, "validation-receipt");
  assert.ok(commands.some((command) => command.includes("pnpm install")));
  assert.deepEqual(renderEvents, ["prepare", "samples", "final", "dispose"]);
  assert.equal(visionRequests.length, 1);
  const receiptPayload = receipts[0]?.payload as {
    sampleDigests?: unknown[];
    cover?: Record<string, unknown>;
    renderedVideo?: Record<string, unknown>;
  };
  assert.equal(receiptPayload.sampleDigests?.length, 3);
  assert.equal(receiptPayload.cover?.blobRef, "cover-wip");
  assert.equal(receiptPayload.renderedVideo?.blobRef, "video-wip");
  assert.equal(
    receiptPayload.renderedVideo?.fileName,
    "黑洞-宇宙的终极谜题.mp4",
  );
  assert.equal(
    receiptPayload.renderedVideo?.contentDigest,
    sha256Digest(renderedVideoBytes),
  );
});

test("final render failure issues no receipt or media WIP", async () => {
  const sourceBytes = new TextEncoder().encode(JSON.stringify(draft()));
  let receipts = 0;
  let wipWrites = 0;
  const validationTool = createValidateVideoPresentationTool({
    profile: null,
    renderPort: failingFinalRenderPort(),
    services: {
      media: { probeAudioDurationSeconds: async () => null },
      operationCache: {
        claimMany: async (input) => ({
          kind: "claimed",
          items: [
            {
              semanticKey: input.semanticKeys[0]!,
              action: "execute",
              claimToken: "claim",
            },
          ],
        }),
        complete: async () => ({ observationId: "observation" }),
        markUnknown: async () => undefined,
      },
      receipts: {
        issueCurrentRunReceipt: async () => {
          receipts += 1;
          return { receiptId: "unexpected" };
        },
        resolveCurrentRunReceipt: async () => null,
      },
      sandbox: {
        allowedReadRoots: ["/workspace"],
        ensureCurrentSession: async () => ({ sessionGeneration: "session" }),
        uploadCurrentFiles: async () => undefined,
        listCurrentFiles: async () => [],
        downloadCurrentFile: async () => new Uint8Array(),
        executeCurrent: async () => ({ exitCode: 0, output: "ok" }),
        captureCurrentTree: async () => [
          {
            relativePath: "video-presentation.draft.json",
            bytes: sourceBytes,
          },
        ],
      },
      workBlobs: {
        putIfAbsent: async (input) => {
          wipWrites += 1;
          return { blobRef: "unexpected", contentDigest: input.contentDigest };
        },
        getVerified: async () => null,
        getBySemanticKey: async () => null,
        deleteScope: async () => undefined,
      },
      modelGateway: {
        getClient: async () => {
          throw new Error("vision client must stay closed");
        },
      },
    },
  });

  const output = (await validationTool.invoke(
    {
      projectRoot: "/workspace/video",
      sourceJsonPath: "/workspace/video/video-presentation.draft.json",
    },
    { toolCallId: "validation-render-failure" } as never,
  )) as Record<string, unknown>;

  assert.equal(output.status, "failed");
  assert.equal(
    (output.diagnostics as Array<Record<string, unknown>>)[0]?.code,
    "VIDEO_RENDER_COMMAND_FAILED",
  );
  assert.equal(receipts, 0);
  assert.equal(wipWrites, 0);
});

test("completed validation reuses only verified cover and MP4 WIP", async () => {
  const parsedDraft = videoPresentationDraftPayloadSchema.parse(draft());
  const validationInputDigest = buildVideoValidationInputDigest({
    draft: parsedDraft,
    resources: [],
  });
  const coverBytes = new Uint8Array([0xff, 0xd8, 1, 0xff, 0xd9]);
  const coverDigest = sha256Digest(coverBytes);
  const videoDigest = sha256Digest(renderedVideoBytes);
  let renderPrepares = 0;
  let verifiedReads = 0;
  const validationTool = createValidateVideoPresentationTool({
    profile: null,
    renderPort: {
      async prepare() {
        renderPrepares += 1;
        throw new Error("cache reuse must not render");
      },
    },
    services: {
      operationCache: {
        claimMany: async () => ({
          kind: "claimed",
          items: [
            {
              semanticKey: "semantic",
              action: "reuse",
              observationId: "observation",
              observation: {
                status: "passed",
                validationInputDigest,
                validationReceiptId: "validation-receipt",
                previewImagePath: "/workspace/validation/out/cover.jpg",
                previewImageDigest: coverDigest,
                renderedVideoDigest: videoDigest,
                renderedVideoByteLength: renderedVideoBytes.byteLength,
                projectClosureDigest: "sha256:closure",
                visualChecked: false,
                validatorVersion: VIDEO_PRESENTATION_VALIDATOR_VERSION,
                renderPolicyVersion: VIDEO_PRESENTATION_RENDER_POLICY.version,
                warnings: ["VIDEO_VISUAL_REVIEW_SKIPPED_NO_PROFILE"],
                diagnostics: [],
              },
            },
          ],
        }),
      },
      receipts: {
        resolveCurrentRunReceipt: async (input: {
          expectedSchemaVersion?: string;
        }) => {
          assert.equal(
            input.expectedSchemaVersion,
            VIDEO_PRESENTATION_VALIDATION_RECEIPT_SCHEMA_VERSION,
          );
          return {
            validationInputDigest,
            validatorVersion: VIDEO_PRESENTATION_VALIDATOR_VERSION,
            renderPolicyVersion: VIDEO_PRESENTATION_RENDER_POLICY.version,
            cover: {
              blobRef: "cover-wip",
              contentDigest: coverDigest,
              contentType: "image/jpeg",
              fileName: "cover.jpg",
              byteLength: coverBytes.byteLength,
              width: 1920,
              height: 1080,
              slideNumber: 1,
              metadata: {},
              previewImagePath: "/workspace/validation/out/cover.jpg",
            },
            renderedVideo: {
              blobRef: "video-wip",
              contentDigest: videoDigest,
              contentType: "video/mp4",
              fileName: "video.mp4",
              byteLength: renderedVideoBytes.byteLength,
              durationInFrames: 150,
              fps: 30,
              width: 1920,
              height: 1080,
              hasAudio: false,
              renderPolicyVersion: VIDEO_PRESENTATION_RENDER_POLICY.version,
              rendererVersion: VIDEO_PRESENTATION_RENDER_POLICY.rendererVersion,
              timings: { totalMs: 10 },
            },
          };
        },
      },
      sandbox: {
        ensureCurrentSession: async () => ({ sessionGeneration: "session" }),
        captureCurrentTree: async () => [
          {
            relativePath: "video-presentation.draft.json",
            bytes: new TextEncoder().encode(JSON.stringify(draft())),
          },
        ],
      },
      workBlobs: {
        getVerified: async ({ blobRef }: { blobRef: string }) => {
          verifiedReads += 1;
          return blobRef === "cover-wip"
            ? { bytes: coverBytes, contentType: "image/jpeg" }
            : { bytes: renderedVideoBytes, contentType: "video/mp4" };
        },
      },
    } as never,
  });

  const output = (await validationTool.invoke(
    {
      projectRoot: "/workspace/video",
      sourceJsonPath: "/workspace/video/video-presentation.draft.json",
    },
    { toolCallId: "validation-cache-reuse" } as never,
  )) as Record<string, unknown>;

  assert.equal(output.status, "passed");
  assert.equal(renderPrepares, 0);
  assert.equal(verifiedReads, 2);
});

test("deterministic draft inconsistencies stop before claims or sandbox execution", async (t) => {
  const cases = [
    {
      name: "missing scene",
      mutate(value: ReturnType<typeof draft>) {
        value.slides.push({
          slideNumber: 2,
          title: "Two",
          speakerTranscript: ["Two"],
          sceneIntent: "Show two",
          assetRefs: [],
          assetNeeds: [],
        });
      },
    },
    {
      name: "duplicate slide",
      mutate(value: ReturnType<typeof draft>) {
        value.slides.push({ ...value.slides[0]! });
      },
    },
    {
      name: "orphan asset reference",
      mutate(value: ReturnType<typeof draft>) {
        value.slides[0]!.assetRefs = [
          { assetId: "missing", role: "hero" },
        ] as never;
      },
    },
  ];
  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const value = draft();
      fixture.mutate(value);
      const sourceBytes = new TextEncoder().encode(JSON.stringify(value));
      let claimed = false;
      let executed = false;
      const validationTool = createValidateVideoPresentationTool({
        profile: null,
        services: {
          operationCache: {
            claimMany: async () => {
              claimed = true;
              throw new Error("claim must not run");
            },
          },
          sandbox: {
            captureCurrentTree: async () => [
              {
                relativePath: "video-presentation.draft.json",
                bytes: sourceBytes,
              },
            ],
            executeCurrent: async () => {
              executed = true;
              throw new Error("execute must not run");
            },
          },
        } as never,
      });
      const output = (await validationTool.invoke(
        {
          projectRoot: "/workspace/video",
          sourceJsonPath: "/workspace/video/video-presentation.draft.json",
        },
        { toolCallId: `invalid-${fixture.name}` } as never,
      )) as Record<string, unknown>;
      assert.equal(output.code, "VIDEO_DRAFT_STRUCTURE_INVALID");
      assert.equal(claimed, false);
      assert.equal(executed, false);
    });
  }
});

test("missing vision profile preserves deterministic validation with an explicit warning", async () => {
  const sourceBytes = new TextEncoder().encode(JSON.stringify(draft()));
  let modelClientOpened = false;
  const validationTool = createValidateVideoPresentationTool({
    renderPort: successfulRenderPort(),
    profile: null,
    services: {
      media: { probeAudioDurationSeconds: async () => null },
      operationCache: {
        claimMany: async (input) => ({
          kind: "claimed",
          items: [
            {
              semanticKey: input.semanticKeys[0]!,
              action: "execute",
              claimToken: "claim",
            },
          ],
        }),
        complete: async () => ({ observationId: "observation" }),
        markUnknown: async () => undefined,
      },
      receipts: {
        issueCurrentRunReceipt: async () => ({ receiptId: "receipt" }),
        resolveCurrentRunReceipt: async () => null,
      },
      sandbox: {
        allowedReadRoots: ["/workspace"],
        ensureCurrentSession: async () => ({ sessionGeneration: "session" }),
        uploadCurrentFiles: async () => undefined,
        listCurrentFiles: async () => [],
        downloadCurrentFile: async () => new Uint8Array([0xff, 0xd8, 0xff]),
        executeCurrent: async () => ({ exitCode: 0, output: "ok" }),
        captureCurrentTree: async () => [
          {
            relativePath: "video-presentation.draft.json",
            bytes: sourceBytes,
          },
        ],
      },
      workBlobs: {
        putIfAbsent: async (input) => ({
          blobRef: `blob-${input.contentDigest}`,
          contentDigest: input.contentDigest,
        }),
        getVerified: async () => null,
        getBySemanticKey: async () => null,
        deleteScope: async () => undefined,
      },
      modelGateway: {
        getClient: async () => {
          modelClientOpened = true;
          throw new Error("vision client must stay closed");
        },
      },
    },
  });
  const output = (await validationTool.invoke(
    {
      projectRoot: "/workspace/video",
      sourceJsonPath: "/workspace/video/video-presentation.draft.json",
    },
    { toolCallId: "validation-no-vision" } as never,
  )) as Record<string, unknown>;
  assert.equal(output.status, "passed");
  assert.equal(output.visualChecked, false);
  assert.deepEqual(output.warnings, ["VIDEO_VISUAL_REVIEW_SKIPPED_NO_PROFILE"]);
  assert.equal(modelClientOpened, false);
});

test("validation re-probes frozen narration and receipts the host measurement", async () => {
  const audioBytes = new Uint8Array([0x49, 0x44, 0x33, 0, 0, 0, 0]);
  const audioDigest = sha256Digest(audioBytes);
  const value = draft() as any;
  value.narrationPolicy = { enabled: true };
  value.project.durationSeconds = 6;
  value.sceneModules[0].durationInFrames = 180;
  value.audioTracks = [
    {
      slideNumber: 1,
      durationSeconds: 4.9,
      mimeType: "audio/mpeg",
      fileName: "slide-1.mp3",
      resource: {
        kind: "local",
        sandboxPath: "/workspace/video/public/audio/slide-1.mp3",
        blobRef: "audio-wip",
        contentDigest: audioDigest,
        contentType: "audio/mpeg",
      },
    },
  ];
  const sourceBytes = new TextEncoder().encode(JSON.stringify(value));
  const receiptPayloads: Array<Record<string, unknown>> = [];
  const validationTool = createValidateVideoPresentationTool({
    renderPort: successfulRenderPort(),
    profile: null,
    services: {
      media: { probeAudioDurationSeconds: async () => 5 },
      operationCache: {
        claimMany: async (input) => ({
          kind: "claimed",
          items: [
            {
              semanticKey: input.semanticKeys[0]!,
              action: "execute",
              claimToken: "claim",
            },
          ],
        }),
        complete: async () => ({ observationId: "observation" }),
        markUnknown: async () => undefined,
      },
      receipts: {
        issueCurrentRunReceipt: async (input) => {
          receiptPayloads.push(input.payload);
          return { receiptId: "receipt" };
        },
        resolveCurrentRunReceipt: async () => null,
      },
      sandbox: {
        allowedReadRoots: ["/workspace"],
        ensureCurrentSession: async () => ({ sessionGeneration: "session" }),
        uploadCurrentFiles: async () => undefined,
        listCurrentFiles: async () => [],
        downloadCurrentFile: async () => new Uint8Array([0xff, 0xd8, 0xff]),
        executeCurrent: async () => ({ exitCode: 0, output: "ok" }),
        captureCurrentTree: async () => [
          {
            relativePath: "video-presentation.draft.json",
            bytes: sourceBytes,
          },
          {
            relativePath: "public/audio/slide-1.mp3",
            bytes: audioBytes,
          },
        ],
      },
      workBlobs: {
        putIfAbsent: async (input) => ({
          blobRef: `blob-${input.contentDigest}`,
          contentDigest: input.contentDigest,
        }),
        getVerified: async (input) =>
          input.blobRef === "audio-wip"
            ? { bytes: audioBytes, contentType: "audio/mpeg" }
            : null,
        getBySemanticKey: async () => null,
        deleteScope: async () => undefined,
      },
      modelGateway: {
        getClient: async () => {
          throw new Error("vision client must stay closed");
        },
      },
    },
  });

  const output = (await validationTool.invoke(
    {
      projectRoot: "/workspace/video",
      sourceJsonPath: "/workspace/video/video-presentation.draft.json",
    },
    { toolCallId: "validation-audio" } as never,
  )) as Record<string, unknown>;

  assert.equal(output.status, "passed");
  assert.deepEqual(receiptPayloads[0]?.measuredAudioTracks, [
    { slideNumber: 1, durationSeconds: 5, mimeType: "audio/mpeg" },
  ]);
});

test("committed resource bytes cannot replace protected load authority", async () => {
  const replacementBytes = new Uint8Array([9, 8, 7]);
  const replacementDigest = sha256Digest(replacementBytes);
  const value = draft() as any;
  value.slides[0].assetRefs = [{ assetId: "hero", role: "hero" }];
  value.sceneModules[0].code =
    'export default function VideoScene(){ const frame = useCurrentFrame(); return <AbsoluteFill><AssetImage src="sourceweft-asset:hero" /></AbsoluteFill>; }';
  value.assets = [
    {
      assetId: "hero",
      type: "hero",
      prompt: "Hero",
      slideNumbers: [1],
      source: "generated",
      resource: {
        kind: "committed",
        resourceHandle: "handle-hero",
        contentDigest: replacementDigest,
        contentType: "image/png",
      },
    },
  ];
  const sourceBytes = new TextEncoder().encode(JSON.stringify(value));
  let claimed = false;
  const validationTool = createValidateVideoPresentationTool({
    profile: null,
    services: {
      receipts: {
        issueCurrentRunReceipt: async () => ({ receiptId: "unused" }),
        resolveCurrentRunReceipt: async () => ({
          artifactId: "artifact-1",
          versionId: "version-1",
          versionNo: 1,
          projectRoot: "/workspace/video",
          sourceJsonPath: "/workspace/video/video-presentation.draft.json",
          projectClosureDigest: "sha256:old-project",
          sourceDigest: "old-source",
          resourceAuthority: {
            "handle-hero": {
              kind: "asset",
              assetId: "hero",
              storageKey:
                "workspaces/workspace-1/artifacts/artifact-1/old-hero.png",
              storageBucket: "content",
              contentDigest: sha256Digest(new Uint8Array([1, 2, 3])),
              contentType: "image/png",
              sandboxPath: "/workspace/video/public/assets/old-hero.png",
            },
          },
        }),
      },
      operationCache: {
        claimMany: async () => {
          claimed = true;
          throw new Error("claim must not run");
        },
      },
      sandbox: {
        captureCurrentTree: async () => [
          {
            relativePath: "video-presentation.draft.json",
            bytes: sourceBytes,
          },
          {
            relativePath: "public/assets/old-hero.png",
            bytes: replacementBytes,
          },
        ],
      },
    } as never,
  });

  const output = (await validationTool.invoke(
    {
      projectRoot: "/workspace/video",
      sourceJsonPath: "/workspace/video/video-presentation.draft.json",
      loadReceiptId: "load-receipt",
    },
    { toolCallId: "validation-forged-resource" } as never,
  )) as Record<string, unknown>;

  assert.equal(output.code, "VIDEO_ASSET_RECEIPT_MISMATCH");
  assert.equal(claimed, false);
});

test("visual validation forwards cancellation, disposes rendering, and fences its execute claim", async () => {
  const controller = new AbortController();
  const abortReason = new Error("tool timed out");
  const renderEvents: string[] = [];
  const unknownReasons: string[] = [];
  let receipts = 0;
  let wipWrites = 0;
  const sourceBytes = new TextEncoder().encode(JSON.stringify(draft()));
  const validationTool = createValidateVideoPresentationTool({
    renderPort: successfulRenderPort(renderEvents),
    profile: {
      gatewayConfigId: "vision-gateway",
      profileAlias: "vision-default",
      modelAlias: "vision-model",
    },
    services: {
      media: { probeAudioDurationSeconds: async () => null },
      operationCache: {
        claimMany: async (input) => ({
          kind: "claimed",
          items: [
            {
              semanticKey: input.semanticKeys[0]!,
              action: "execute",
              claimToken: "validation-abort-claim",
            },
          ],
        }),
        complete: async () => {
          throw new Error("an aborted validation must not complete");
        },
        markUnknown: async (input) => {
          unknownReasons.push(input.reason);
        },
      },
      receipts: {
        issueCurrentRunReceipt: async () => {
          receipts += 1;
          return { receiptId: "unexpected" };
        },
        resolveCurrentRunReceipt: async () => null,
      },
      sandbox: {
        allowedReadRoots: ["/workspace"],
        ensureCurrentSession: async () => ({ sessionGeneration: "session" }),
        uploadCurrentFiles: async () => undefined,
        listCurrentFiles: async () => [],
        downloadCurrentFile: async () => new Uint8Array(),
        executeCurrent: async () => ({ exitCode: 0, output: "ok" }),
        captureCurrentTree: async () => [
          {
            relativePath: "video-presentation.draft.json",
            bytes: sourceBytes,
          },
        ],
      },
      workBlobs: {
        putIfAbsent: async (input) => {
          wipWrites += 1;
          return { blobRef: "unexpected", contentDigest: input.contentDigest };
        },
        getVerified: async () => null,
        getBySemanticKey: async () => null,
        deleteScope: async () => undefined,
      },
      modelGateway: {
        getClient: async () =>
          ({
            chat: {
              complete: async (
                _request: unknown,
                options: { signal?: AbortSignal },
              ) => {
                assert.equal(options.signal, controller.signal);
                controller.abort(abortReason);
                throw abortReason;
              },
            },
          }) as never,
      },
    },
  });

  await assert.rejects(
    validationTool.invoke(
      {
        projectRoot: "/workspace/video",
        sourceJsonPath: "/workspace/video/video-presentation.draft.json",
      },
      withAgentToolHostInvocationSignal(
        { toolCallId: "validation-abort" },
        controller.signal,
      ) as never,
    ),
    (error) => error === abortReason,
  );

  assert.deepEqual(renderEvents, ["prepare", "samples", "dispose"]);
  assert.deepEqual(unknownReasons, ["VALIDATION_TOOL_ABORTED"]);
  assert.equal(receipts, 0);
  assert.equal(wipWrites, 0);
});
