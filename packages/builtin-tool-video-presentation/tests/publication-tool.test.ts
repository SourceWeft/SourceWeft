import assert from "node:assert/strict";
import test from "node:test";
import {
  withAgentToolHostInvocationSignal,
  type AgentToolCurrentRunArtifactPublicationServices,
} from "@sourceweft/contracts/agent-tools";
import { VIDEO_PRESENTATION_WORKFLOW_VERSION } from "@sourceweft/contracts/video-presentation";
import { createPublishVideoPresentationTool } from "../src/agent/publication-tool";
import { videoPresentationArtifactViewHandler } from "../src/artifact-view";
import {
  VIDEO_PRESENTATION_BUILDER_VERSION,
  sha256Digest,
} from "../src/agent/common";
import {
  buildVideoValidationInputDigest,
  VIDEO_PRESENTATION_VALIDATOR_VERSION,
} from "../src/agent/validation-identity";

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
      title: "Published video",
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
        code: "export default function VideoScene(){ return null; }",
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

function createUnknownPublicationHarness(input: {
  publishCommitted: () => Promise<
    Awaited<
      ReturnType<
        AgentToolCurrentRunArtifactPublicationServices["publishCommitted"]
      >
    >
  >;
  onStorageUpload?: (input: { signal?: AbortSignal }) => Promise<void>;
  sourceBytes?: Uint8Array;
}) {
  const draftValue = draft() as any;
  const sourceBytes =
    input.sourceBytes ?? new TextEncoder().encode(JSON.stringify(draftValue));
  const validationInputDigest = buildVideoValidationInputDigest({
    draft: draftValue,
    resources: [],
  });
  const coverBytes = new Uint8Array([0xff, 0xd8, 0xff]);
  const renderedVideoBytes = new Uint8Array([
    0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
  ]);
  let deletedObjects = 0;
  const deletedKeys: string[] = [];
  let cleanedPreallocations = 0;
  let unknowns = 0;
  let publishCalls = 0;
  const tool = createPublishVideoPresentationTool({
    workspaceId: "workspace-1",
    services: {
      currentRunArtifacts: {
        allocateArtifactId: () => "artifact-unknown",
        cleanupPreallocatedArtifact: async () => {
          cleanedPreallocations += 1;
        },
        publishCommitted: async () => {
          publishCalls += 1;
          return input.publishCommitted();
        },
      },
      operationCache: {
        claimMany: async (claimInput) => ({
          kind: "claimed",
          items: [
            {
              semanticKey: claimInput.semanticKeys[0]!,
              action: "execute",
              claimToken: "publish-unknown-claim",
            },
          ],
        }),
        complete: async () => ({ observationId: "observation" }),
        markUnknown: async () => {
          unknowns += 1;
        },
      },
      receipts: {
        issueCurrentRunReceipt: async () => ({ receiptId: "unused" }),
        resolveCurrentRunReceipt: async (receiptInput) =>
          receiptInput.producerToolName === "validate_video_presentation"
            ? {
                projectRoot: "/workspace/video",
                sourceJsonPath:
                  "/workspace/video/video-presentation.draft.json",
                validationInputDigest,
                projectClosureDigest: "sha256:project",
                validatorVersion: VIDEO_PRESENTATION_VALIDATOR_VERSION,
                builderVersion: VIDEO_PRESENTATION_BUILDER_VERSION,
                projectCode: {
                  install: { ok: true, diagnostics: [] },
                  typecheck: { ok: true, diagnostics: [] },
                  smoke: { checked: true, ok: true, diagnostics: [] },
                },
                measuredAudioTracks: [],
                sampleDigests: [],
                renderPolicyVersion: "video-render-policy",
                rendererVersion: "remotion-renderer",
                cover: {
                  blobRef: "cover-wip",
                  contentDigest: sha256Digest(coverBytes),
                  contentType: "image/jpeg",
                  fileName: "cover.jpg",
                  byteLength: coverBytes.byteLength,
                  width: 1920,
                  height: 1080,
                  slideNumber: 1,
                  metadata: { fileName: "cover.jpg" },
                  previewImagePath: "/workspace/video/out/cover.jpg",
                },
                renderedVideo: {
                  blobRef: "video-wip",
                  contentDigest: sha256Digest(renderedVideoBytes),
                  contentType: "video/mp4",
                  fileName: "video.mp4",
                  byteLength: renderedVideoBytes.byteLength,
                  durationInFrames: 150,
                  fps: 30,
                  width: 1920,
                  height: 1080,
                  hasAudio: false,
                  renderPolicyVersion: "video-render-policy",
                  rendererVersion: "remotion-renderer",
                  timings: { totalMs: 100 },
                },
              }
            : null,
      },
      sandbox: {
        allowedReadRoots: ["/workspace"],
        ensureCurrentSession: async () => ({ sessionGeneration: "session" }),
        uploadCurrentFiles: async () => undefined,
        listCurrentFiles: async () => [],
        downloadCurrentFile: async () => new Uint8Array(),
        executeCurrent: async () => ({ exitCode: 0, output: "" }),
        captureCurrentTree: async () => [
          {
            relativePath: "video-presentation.draft.json",
            bytes: sourceBytes,
          },
        ],
      },
      storage: {
        buildArtifactStorageKey: ({ workspaceId, artifactId, fileName }) =>
          `workspaces/${workspaceId}/artifacts/${artifactId}/${fileName}`,
        getBucketName: () => "content",
        upload: async (uploadInput) => input.onStorageUpload?.(uploadInput),
        download: async () => null,
        delete: async ({ key }) => {
          deletedObjects += 1;
          deletedKeys.push(key);
        },
      },
      workBlobs: {
        putIfAbsent: async () => ({
          blobRef: "unused",
          contentDigest: "unused",
        }),
        getVerified: async (blobInput) =>
          blobInput.blobRef === "cover-wip"
            ? { bytes: coverBytes, contentType: "image/jpeg" }
            : blobInput.blobRef === "video-wip"
              ? { bytes: renderedVideoBytes, contentType: "video/mp4" }
              : null,
        getBySemanticKey: async () => null,
        deleteScope: async () => undefined,
      },
    },
  });
  return {
    invoke: (signal?: AbortSignal) =>
      tool.invoke(
        {
          projectRoot: "/workspace/video",
          sourceJsonPath: "/workspace/video/video-presentation.draft.json",
          validationReceiptId: "validation-receipt",
        },
        (signal
          ? withAgentToolHostInvocationSignal(
              { toolCallId: "publish-unknown-call" },
              signal,
            )
          : { toolCallId: "publish-unknown-call" }) as never,
      ),
    counts: () => ({
      deletedObjects,
      cleanedPreallocations,
      unknowns,
      publishCalls,
    }),
    deletedKeys: () => [...deletedKeys],
  };
}

test("publisher cannot begin an atomic commit after its invocation is aborted", async () => {
  const controller = new AbortController();
  const abortReason = new DOMException("tool timed out", "TimeoutError");
  let uploadStarted!: () => void;
  let uploadCount = 0;
  const uploadSignals: Array<AbortSignal | undefined> = [];
  const started = new Promise<void>((resolve) => {
    uploadStarted = resolve;
  });
  const harness = createUnknownPublicationHarness({
    publishCommitted: async () => {
      throw new Error("publication must remain fenced");
    },
    onStorageUpload: async ({ signal }) => {
      uploadCount += 1;
      uploadSignals.push(signal);
      if (uploadCount === 1) return;
      uploadStarted();
      await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
  });

  const invocation = harness.invoke(controller.signal);
  await started;
  controller.abort(abortReason);
  let settled = false;
  void invocation.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await Promise.resolve();
  assert.equal(settled, false);

  await assert.rejects(invocation, (error: unknown) => error === abortReason);
  assert.deepEqual(uploadSignals, [controller.signal, controller.signal]);
  assert.equal(harness.counts().publishCalls, 0);
  assert.equal(harness.counts().unknowns, 1);
  assert.equal(harness.counts().deletedObjects, 2);
  assert.deepEqual(harness.deletedKeys(), [
    "workspaces/workspace-1/artifacts/artifact-unknown/cover.jpg",
    "workspaces/workspace-1/artifacts/artifact-unknown/video.mp4",
  ]);
  assert.equal(harness.counts().cleanedPreallocations, 1);
});

test("publisher rechecks validation digest and returns only the atomic committed result", async () => {
  const assetBytes = new Uint8Array([1, 2, 3, 4]);
  const assetDigest = sha256Digest(assetBytes);
  const draftValue = draft() as any;
  draftValue.slides[0].assetRefs = [{ assetId: "hero", role: "hero" }];
  draftValue.sceneModules[0].code =
    'export default function VideoScene(){ return <AssetImage src="sourceweft-asset:hero" />; }';
  draftValue.assets = [
    {
      assetId: "hero",
      type: "hero",
      prompt: "Hero",
      slideNumbers: [1],
      source: "generated",
      resource: {
        kind: "local",
        sandboxPath: "/workspace/video/public/assets/hero.png",
        blobRef: "asset-wip",
        contentDigest: assetDigest,
        contentType: "image/png",
      },
    },
  ];
  const sourceBytes = new TextEncoder().encode(JSON.stringify(draftValue));
  const validationInputDigest = buildVideoValidationInputDigest({
    draft: draftValue,
    resources: [{ identity: "asset:hero", bytes: assetBytes }],
  });
  const coverBytes = new Uint8Array([0xff, 0xd8, 0xff]);
  const renderedVideoBytes = new Uint8Array([
    0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
  ]);
  const projectCode = {
    install: { ok: true, diagnostics: [] },
    typecheck: { ok: true, diagnostics: [] },
    smoke: { checked: true, ok: true, diagnostics: [] },
  };
  const published: Array<Record<string, unknown>> = [];
  const uploaded: Array<{ key: string; body: Uint8Array }> = [];
  const committedResult = {
    status: "ready" as const,
    type: "committed_artifact_result" as const,
    artifactType: "video_presentation",
    artifactId: "artifact-1",
    artifactVersionId: "version-1",
    artifactOutputBlockId: "artifact-output:run-1:artifact-1:version-1",
    workflowVersion: VIDEO_PRESENTATION_WORKFLOW_VERSION,
  };
  const publishTool = createPublishVideoPresentationTool({
    workspaceId: "workspace-1",
    services: {
      currentRunArtifacts: {
        allocateArtifactId: () => "artifact-1",
        cleanupPreallocatedArtifact: async () => undefined,
        publishCommitted: async (input) => {
          published.push(input as Record<string, unknown>);
          return {
            ok: true,
            result: committedResult,
            reused: false,
            versionNo: 1,
          };
        },
      },
      operationCache: {
        claimMany: async (input) => ({
          kind: "claimed",
          items: [
            {
              semanticKey: input.semanticKeys[0]!,
              action: "execute",
              claimToken: "publish-claim",
            },
          ],
        }),
        complete: async () => ({ observationId: "publish-observation" }),
        markUnknown: async () => undefined,
      },
      receipts: {
        issueCurrentRunReceipt: async () => ({ receiptId: "unused" }),
        resolveCurrentRunReceipt: async (input) =>
          input.producerToolName === "validate_video_presentation"
            ? {
                projectRoot: "/workspace/video",
                sourceJsonPath:
                  "/workspace/video/video-presentation.draft.json",
                validationInputDigest,
                projectClosureDigest: "sha256:project",
                validatorVersion: VIDEO_PRESENTATION_VALIDATOR_VERSION,
                builderVersion: VIDEO_PRESENTATION_BUILDER_VERSION,
                projectCode,
                measuredAudioTracks: [],
                sampleDigests: [],
                renderPolicyVersion: "video-render-policy",
                rendererVersion: "remotion-renderer",
                cover: {
                  blobRef: "cover-wip",
                  contentDigest: sha256Digest(coverBytes),
                  contentType: "image/jpeg",
                  fileName: "cover.jpg",
                  byteLength: coverBytes.byteLength,
                  width: 1920,
                  height: 1080,
                  slideNumber: 1,
                  metadata: {
                    fileName: "cover.jpg",
                    mimeType: "image/jpeg",
                    byteLength: coverBytes.byteLength,
                  },
                  previewImagePath: "/workspace/validation/cover.jpg",
                },
                renderedVideo: {
                  blobRef: "rendered-video-wip",
                  contentDigest: sha256Digest(renderedVideoBytes),
                  contentType: "video/mp4",
                  fileName: "published-video.mp4",
                  byteLength: renderedVideoBytes.byteLength,
                  durationInFrames: 150,
                  fps: 30,
                  width: 1920,
                  height: 1080,
                  hasAudio: false,
                  renderPolicyVersion: "video-render-policy",
                  rendererVersion: "remotion-renderer",
                  timings: { totalMs: 100 },
                },
              }
            : null,
      },
      sandbox: {
        allowedReadRoots: ["/workspace"],
        ensureCurrentSession: async () => ({ sessionGeneration: "session" }),
        uploadCurrentFiles: async () => undefined,
        listCurrentFiles: async () => [],
        downloadCurrentFile: async () => new Uint8Array(),
        executeCurrent: async () => ({ exitCode: 0, output: "" }),
        captureCurrentTree: async () => [
          {
            relativePath: "video-presentation.draft.json",
            bytes: sourceBytes,
          },
          {
            relativePath: "public/assets/hero.png",
            bytes: assetBytes,
          },
        ],
      },
      storage: {
        buildArtifactStorageKey: ({ workspaceId, artifactId, fileName }) =>
          `workspaces/${workspaceId}/artifacts/${artifactId}/host-${fileName}`,
        getBucketName: () => "content",
        upload: async (input) => {
          uploaded.push({ key: input.key, body: input.body });
        },
        delete: async () => undefined,
        download: async () => null,
      },
      workBlobs: {
        putIfAbsent: async () => ({
          blobRef: "unused",
          contentDigest: "unused",
        }),
        getVerified: async (input) =>
          input.blobRef === "cover-wip"
            ? { bytes: coverBytes, contentType: "image/jpeg" }
            : input.blobRef === "rendered-video-wip"
              ? { bytes: renderedVideoBytes, contentType: "video/mp4" }
              : input.blobRef === "asset-wip"
                ? { bytes: assetBytes, contentType: "image/png" }
                : null,
        getBySemanticKey: async () => null,
        deleteScope: async () => undefined,
      },
    },
  });

  const output = await publishTool.invoke(
    {
      projectRoot: "/workspace/video",
      sourceJsonPath: "/workspace/video/video-presentation.draft.json",
      validationReceiptId: "validation-receipt",
    },
    { toolCallId: "publish-call" } as never,
  );

  assert.deepEqual(output, committedResult);
  assert.equal(published.length, 1);
  assert.equal(
    (published[0]?.payload as Record<string, unknown>).kind,
    "video_presentation",
  );
  assert.match(
    uploaded[0]!.key,
    /^workspaces\/workspace-1\/artifacts\/artifact-1\//u,
  );
  const publishedPayload = published[0]?.payload as Record<string, unknown>;
  const publishedAsset = (
    publishedPayload.assets as Array<Record<string, unknown>>
  )[0]!;
  assert.equal(
    publishedAsset.sourceUrl,
    "/v1/workspaces/workspace-1/artifacts/artifact-1/assets/host-hero.png",
  );
  assert.equal(
    String(publishedAsset.storageKey).endsWith("/host-hero.png"),
    true,
  );
  assert.equal(publishedAsset.contentDigest, assetDigest);
  assert.equal(publishedAsset.contentType, "image/png");
  const renderedVideo = publishedPayload.renderedVideo as Record<
    string,
    unknown
  >;
  assert.equal(renderedVideo.mimeType, "video/mp4");
  assert.equal(renderedVideo.contentDigest, sha256Digest(renderedVideoBytes));
  const coverImage = publishedPayload.coverImage as Record<string, unknown>;
  assert.equal(coverImage.mimeType, "image/jpeg");
  assert.equal(coverImage.contentDigest, sha256Digest(coverBytes));
  const source = videoPresentationArtifactViewHandler.buildSourceJson?.({
    artifact: {
      artifactType: "video_presentation",
      status: "ready",
      title: "Published video",
      storageBucket: null,
      storageKey: null,
      payloadJson: published[0]?.payload,
    },
  });
  assert.equal(source?.payload.kind, "video_presentation");
  const sourceScenes = source?.payload.sceneModules as Array<
    Record<string, unknown>
  >;
  assert.equal("repairAttempts" in sourceScenes[0]!, false);
});

test("publisher retries the same call identity once after an unknown response", async () => {
  const committedResult = {
    status: "ready" as const,
    type: "committed_artifact_result" as const,
    artifactType: "video_presentation",
    artifactId: "artifact-unknown",
    artifactVersionId: "version-1",
    artifactOutputBlockId: "artifact-output:run-1:artifact-unknown:version-1",
    workflowVersion: VIDEO_PRESENTATION_WORKFLOW_VERSION,
  };
  let attempt = 0;
  const harness = createUnknownPublicationHarness({
    publishCommitted: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("response lost after commit");
      return {
        ok: true as const,
        result: committedResult,
        reused: true,
        versionNo: 1,
      };
    },
  });

  assert.deepEqual(await harness.invoke(), committedResult);
  assert.deepEqual(harness.counts(), {
    deletedObjects: 0,
    cleanedPreallocations: 0,
    unknowns: 0,
    publishCalls: 2,
  });
});

test("publisher retains uploaded objects when both commit responses are unknown", async () => {
  const harness = createUnknownPublicationHarness({
    publishCommitted: async () => {
      throw new Error("publication outcome unavailable");
    },
  });

  assert.deepEqual(await harness.invoke(), {
    status: "blocked",
    code: "VIDEO_PUBLICATION_OUTCOME_UNKNOWN",
    message:
      "Publication may have committed, but the host could not confirm the result. Uploaded objects were retained and must not be deleted.",
    diagnostics: [],
  });
  assert.deepEqual(harness.counts(), {
    deletedObjects: 0,
    cleanedPreallocations: 0,
    unknowns: 1,
    publishCalls: 2,
  });
});

test("publisher never cleans up when a retry rejects after an unknown first response", async () => {
  let call = 0;
  const harness = createUnknownPublicationHarness({
    publishCommitted: async () => {
      call += 1;
      if (call === 1) throw new Error("response lost after commit");
      return { ok: false as const, reason: "run_inactive" as const };
    },
  });

  const output = (await harness.invoke()) as Record<string, unknown>;
  assert.equal(output.code, "VIDEO_PUBLICATION_OUTCOME_UNKNOWN");
  assert.deepEqual(harness.counts(), {
    deletedObjects: 0,
    cleanedPreallocations: 0,
    unknowns: 1,
    publishCalls: 2,
  });
});

test("publisher reports invalid draft input without leaking parser details", async () => {
  const harness = createUnknownPublicationHarness({
    publishCommitted: async () => {
      throw new Error("must not publish");
    },
    sourceBytes: new TextEncoder().encode(
      '{"kind":"video_presentation_draft","private":"/workspace/secret/customer.json"}',
    ),
  });

  const output = (await harness.invoke()) as Record<string, unknown>;
  assert.equal(output.status, "blocked");
  assert.equal(output.code, "VIDEO_DRAFT_INVALID");
  assert.doesNotMatch(
    JSON.stringify(output),
    /workspace|customer\.json|Zod|schemaVersion/u,
  );
  assert.equal(harness.counts().publishCalls, 0);
});
