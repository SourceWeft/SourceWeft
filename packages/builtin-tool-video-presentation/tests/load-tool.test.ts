import assert from "node:assert/strict";
import test from "node:test";
import { createLoadVideoPresentationTool } from "../src/agent/load-tool";
import { sha256Digest } from "../src/agent/common";

function readyPayload() {
  return {
    schemaVersion: 1,
    kind: "video_presentation",
    requestKey: "request-1",
    workflowVersion: "video-presentation-agent",
    builderVersion: "remotion-project",
    narrationPolicy: { enabled: false },
    project: {
      title: "Loaded project",
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
    audioTracks: [],
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
    assets: [],
    preview: { slideCount: 1, durationSeconds: 5 },
    renderedVideo: {
      assetUrl: "/video",
      storageKey: "workspaces/workspace-1/artifacts/artifact-1/video.mp4",
      storageBucket: "content",
      fileName: "video.mp4",
      mimeType: "video/mp4",
      byteLength: 1024,
      contentDigest: `sha256:${"a".repeat(64)}`,
      durationInFrames: 150,
      fps: 30,
      width: 1920,
      height: 1080,
      hasAudio: false,
    },
    coverImage: {
      assetUrl: "/cover",
      storageKey: "workspaces/workspace-1/artifacts/artifact-1/cover.jpg",
      storageBucket: "content",
      fileName: "cover.jpg",
      mimeType: "image/jpeg",
      byteLength: 128,
      contentDigest: `sha256:${"b".repeat(64)}`,
      width: 1920,
      height: 1080,
      slideNumber: 1,
      metadata: {},
    },
    renderProfile: {
      stylePreset: "technical",
      visualDensity: "balanced",
      durationTarget: "short",
      language: "en",
    },
    themeAssignments: [],
    sourceDigest: "source summary",
    projectCode: {
      install: { ok: true, diagnostics: [] },
      typecheck: { ok: true, diagnostics: [] },
      smoke: { checked: true, ok: true, diagnostics: [] },
    },
  };
}

test("load tool materializes a draft and issues opaque edit authority", async () => {
  const uploads: Array<{ path: string; bytes: Uint8Array }> = [];
  const receipts: Array<Record<string, unknown>> = [];
  const completions: Array<Record<string, unknown>> = [];
  const loadTool = createLoadVideoPresentationTool({
    workspaceId: "workspace-1",
    services: {
      artifactVersions: {
        readAuthorizedCurrentVersion: async () => ({
          artifactId: "artifact-1",
          versionId: "version-1",
          versionNo: 1,
          payload: readyPayload(),
        }),
      },
      operationCache: {
        claimMany: async () => ({
          kind: "claimed",
          items: [
            {
              semanticKey:
                "load-video-presentation:artifact-1:version-1:session-1",
              action: "execute",
              claimToken: "claim-1",
            },
          ],
        }),
        complete: async (input) => {
          completions.push(input);
          return { observationId: "observation-1" };
        },
        markUnknown: async () => undefined,
      },
      receipts: {
        issueCurrentRunReceipt: async (input) => {
          receipts.push(input);
          return { receiptId: "load-receipt-1" };
        },
        resolveCurrentRunReceipt: async () => null,
      },
      sandbox: {
        allowedReadRoots: ["/workspace"],
        ensureCurrentSession: async () => ({
          sessionGeneration: "session-1",
        }),
        uploadCurrentFiles: async (files) => {
          uploads.push(...files);
        },
        listCurrentFiles: async () => [],
        downloadCurrentFile: async () => new Uint8Array(),
        executeCurrent: async () => ({ exitCode: 0, output: "" }),
        captureCurrentTree: async () => [],
      },
      storage: {
        buildArtifactStorageKey: () => "unused",
        getBucketName: () => "content",
        upload: async () => undefined,
        delete: async () => undefined,
        download: async () => null,
      },
    },
  });

  const output = (await loadTool.invoke({ artifactId: "artifact-1" }, {
    toolCallId: "load-call-1",
  } as never)) as Record<string, unknown>;

  assert.equal(output.status, "succeeded");
  assert.equal(output.loadReceiptId, "load-receipt-1");
  assert.ok(
    uploads.some((file) =>
      file.path.endsWith("/video-presentation.draft.json"),
    ),
  );
  assert.equal(receipts.length, 1);
  assert.equal(completions.length, 1);
  assert.equal(JSON.stringify(output).includes("storageKey"), false);
});

test("load tool hides unavailable artifact identity behind a blocker", async () => {
  const loadTool = createLoadVideoPresentationTool({
    workspaceId: "workspace-1",
    services: {
      artifactVersions: { readAuthorizedCurrentVersion: async () => null },
    } as never,
  });
  const output = (await loadTool.invoke({ artifactId: "hidden" }, {
    toolCallId: "load-hidden",
  } as never)) as Record<string, unknown>;
  assert.equal(output.status, "blocked");
  assert.equal(output.code, "VIDEO_PRESENTATION_NOT_FOUND");
});

test("load preserves canonical stable scene asset identities", async () => {
  const assetUrl =
    "/v1/workspaces/workspace-1/artifacts/artifact-1/assets/host-photo.jpg";
  const payload = readyPayload() as any;
  payload.slides[0]!.assetRefs = [{ assetId: "photo", role: "hero" }];
  payload.sceneModules[0]!.code =
    'export default function VideoScene(){ return <AssetImage src="sourceweft-asset:photo" />; }';
  payload.assets = [
    {
      assetId: "photo",
      type: "hero",
      prompt: "A photo",
      fileName: "host-photo.jpg",
      storageKey: "workspaces/workspace-1/artifacts/artifact-1/host-photo.jpg",
      storageBucket: "content",
      sourceUrl: assetUrl,
      contentDigest: sha256Digest(new Uint8Array([1, 2, 3])),
      contentType: "image/jpeg",
      slideNumbers: [1],
      source: "generated",
    },
  ];
  const uploads: Array<{ path: string; bytes: Uint8Array }> = [];
  const loadTool = createLoadVideoPresentationTool({
    workspaceId: "workspace-1",
    services: {
      artifactVersions: {
        readAuthorizedCurrentVersion: async () => ({
          artifactId: "artifact-1",
          versionId: "version-1",
          versionNo: 1,
          payload,
        }),
      },
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
        uploadCurrentFiles: async (files) => {
          uploads.push(...files);
        },
        listCurrentFiles: async () => [],
        downloadCurrentFile: async () => new Uint8Array(),
        executeCurrent: async () => ({ exitCode: 0, output: "" }),
        captureCurrentTree: async () => [],
      },
      storage: {
        buildArtifactStorageKey: () => "unused",
        getBucketName: () => "content",
        upload: async () => undefined,
        delete: async () => undefined,
        download: async () => ({
          body: new Uint8Array([1, 2, 3]),
          contentType: "image/jpeg",
        }),
      },
    },
  });

  const output = (await loadTool.invoke({ artifactId: "artifact-1" }, {
    toolCallId: "load-asset",
  } as never)) as Record<string, unknown>;
  assert.equal(output.status, "succeeded");
  const source = uploads.find((file) =>
    file.path.endsWith("video-presentation.draft.json"),
  );
  assert.ok(source);
  const sourceText = new TextDecoder().decode(source.bytes);
  assert.match(sourceText, /sourceweft-asset:photo/u);
  assert.equal(sourceText.includes(assetUrl), false);
});

test("load rejects replaced resource bytes with a stable non-sensitive blocker", async () => {
  const expectedBytes = new Uint8Array([1, 2, 3]);
  const payload = readyPayload() as any;
  payload.assets = [
    {
      assetId: "private-asset-name",
      type: "hero",
      prompt: "A photo",
      fileName: "private-file.jpg",
      storageKey:
        "workspaces/workspace-1/artifacts/artifact-1/private-file.jpg",
      storageBucket: "content",
      sourceUrl: "/private-source-url",
      contentDigest: sha256Digest(expectedBytes),
      contentType: "image/jpeg",
      slideNumbers: [1],
      source: "generated",
    },
  ];
  const uploads: Array<{ path: string; bytes: Uint8Array }> = [];
  const loadTool = createLoadVideoPresentationTool({
    workspaceId: "workspace-1",
    services: {
      artifactVersions: {
        readAuthorizedCurrentVersion: async () => ({
          artifactId: "artifact-1",
          versionId: "version-1",
          versionNo: 1,
          payload,
        }),
      },
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
        uploadCurrentFiles: async (files) => {
          uploads.push(...files);
        },
        listCurrentFiles: async () => [],
        downloadCurrentFile: async () => new Uint8Array(),
        executeCurrent: async () => ({ exitCode: 0, output: "" }),
        captureCurrentTree: async () => [],
      },
      storage: {
        buildArtifactStorageKey: () => "unused",
        getBucketName: () => "content",
        upload: async () => undefined,
        delete: async () => undefined,
        download: async () => ({
          body: new Uint8Array([9, 9, 9]),
          contentType: "image/jpeg",
        }),
      },
    },
  });

  const output = (await loadTool.invoke({ artifactId: "artifact-1" }, {
    toolCallId: "load-integrity",
  } as never)) as Record<string, unknown>;
  const serialized = JSON.stringify(output);
  assert.equal(output.status, "blocked");
  assert.equal(output.code, "VIDEO_PRESENTATION_RESOURCE_INTEGRITY_FAILED");
  assert.equal(uploads.length, 0);
  assert.doesNotMatch(
    serialized,
    /private-asset-name|private-file|private-source-url|workspaces\//u,
  );
});
