import assert from "node:assert/strict";
import test from "node:test";
import {
  VIDEO_PRESENTATION_BUILDER_VERSION,
  VIDEO_PRESENTATION_WORKFLOW_VERSION,
  parseVideoPresentationDraftPayload,
  videoPresentationDraftPayloadSchema,
  videoPresentationProjectPayloadSchema,
  videoPresentationRenderableProjectSchema,
} from "../src/video-presentation";

const digest = (character: string) => `sha256:${character.repeat(64)}`;

function semanticProject() {
  return {
    narrationPolicy: { enabled: false },
    project: {
      title: "Trusted video",
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
    renderProfile: {
      stylePreset: "technical",
      visualDensity: "balanced",
      durationTarget: "short",
      language: "en",
    },
    themeAssignments: [],
    sourceDigest: "source",
  } as const;
}

function draft(overrides: Record<string, unknown> = {}) {
  return {
    ...semanticProject(),
    schemaVersion: 1,
    kind: "video_presentation_draft",
    workflowVersion: VIDEO_PRESENTATION_WORKFLOW_VERSION,
    builderVersion: VIDEO_PRESENTATION_BUILDER_VERSION,
    audioTracks: [],
    assets: [],
    ...overrides,
  };
}

function committed() {
  return {
    ...semanticProject(),
    schemaVersion: 1,
    kind: "video_presentation",
    requestKey: "request-1",
    workflowVersion: VIDEO_PRESENTATION_WORKFLOW_VERSION,
    builderVersion: VIDEO_PRESENTATION_BUILDER_VERSION,
    audioTracks: [],
    assets: [],
    preview: { slideCount: 1, durationSeconds: 5 },
    renderedVideo: {
      assetUrl: "/video",
      storageKey: "workspaces/w/artifacts/a/video.mp4",
      storageBucket: "content",
      fileName: "video.mp4",
      mimeType: "video/mp4",
      byteLength: 1024,
      contentDigest: digest("a"),
      durationInFrames: 150,
      fps: 30,
      width: 1920,
      height: 1080,
      hasAudio: false,
    },
    coverImage: {
      assetUrl: "/cover",
      storageKey: "workspaces/w/artifacts/a/cover.jpg",
      storageBucket: "content",
      fileName: "cover.jpg",
      mimeType: "image/jpeg",
      byteLength: 512,
      contentDigest: digest("b"),
      width: 1920,
      height: 1080,
      slideNumber: 1,
      metadata: {},
    },
    projectCode: {
      install: { ok: true, diagnostics: [] },
      typecheck: { ok: true, diagnostics: [] },
      smoke: { checked: true, ok: true, diagnostics: [] },
    },
  };
}

test("draft contract is the single current authored format", () => {
  const parsed = videoPresentationDraftPayloadSchema.parse(draft());
  assert.equal(parsed.workflowVersion, VIDEO_PRESENTATION_WORKFLOW_VERSION);
  assert.equal(parsed.builderVersion, VIDEO_PRESENTATION_BUILDER_VERSION);
  assert.equal("generation" in parsed, false);
});

test("create rejects committed handles and edit requires exact authority", () => {
  const resource = {
    kind: "committed" as const,
    resourceHandle: "resource-1",
    contentDigest: digest("c"),
    contentType: "image/png",
  };
  const value = draft({
    assets: [
      {
        assetId: "hero",
        type: "hero",
        prompt: "Hero",
        slideNumbers: [1],
        source: "generated",
        resource,
      },
    ],
  });
  assert.throws(() =>
    parseVideoPresentationDraftPayload(value, { mode: "create" }),
  );
  assert.throws(() =>
    parseVideoPresentationDraftPayload(value, {
      mode: "edit",
      authorizedResourceHandles: new Set(),
    }),
  );
  assert.equal(
    parseVideoPresentationDraftPayload(value, {
      mode: "edit",
      authorizedResourceHandles: new Set(["resource-1"]),
    }).assets.length,
    1,
  );
});

test("local resources require durable WIP identity and canonical digest", () => {
  const value = draft({
    assets: [
      {
        assetId: "hero",
        type: "hero",
        prompt: "Hero",
        slideNumbers: [1],
        source: "generated",
        resource: {
          kind: "local",
          sandboxPath: "/workspace/hero.png",
          contentDigest: "sha256:not-a-digest",
          contentType: "image/png",
        },
      },
    ],
  });
  assert.equal(
    videoPresentationDraftPayloadSchema.safeParse(value).success,
    false,
  );
});

test("narration policy requires one measured track per slide", () => {
  const enabled = draft({ narrationPolicy: { enabled: true } });
  assert.equal(
    videoPresentationDraftPayloadSchema.safeParse(enabled).success,
    false,
  );
  const withTrack = draft({
    narrationPolicy: { enabled: true },
    audioTracks: [
      {
        slideNumber: 1,
        durationSeconds: 4,
        mimeType: "audio/mpeg",
        fileName: "slide-1.mp3",
        resource: {
          kind: "local",
          sandboxPath: "/workspace/slide-1.mp3",
          blobRef: "blob-1",
          contentDigest: digest("d"),
          contentType: "audio/mpeg",
        },
      },
    ],
  });
  assert.equal(
    videoPresentationDraftPayloadSchema.safeParse(withTrack).success,
    true,
  );
});

test("committed payload requires immutable MP4, cover, buckets, and verdicts", () => {
  const parsed = videoPresentationProjectPayloadSchema.parse(committed());
  assert.equal(parsed.renderedVideo.mimeType, "video/mp4");
  assert.equal(parsed.coverImage.storageBucket, "content");
  for (const key of ["renderedVideo", "coverImage", "projectCode"] as const) {
    const missing = { ...committed() } as Record<string, unknown>;
    delete missing[key];
    assert.equal(
      videoPresentationProjectPayloadSchema.safeParse(missing).success,
      false,
    );
  }
  const noBucket = committed();
  delete (noBucket.renderedVideo as { storageBucket?: string }).storageBucket;
  assert.equal(
    videoPresentationProjectPayloadSchema.safeParse(noBucket).success,
    false,
  );
});

test("committed narration and visual assets require immutable digest and content type", () => {
  const value = committed() as any;
  value.narrationPolicy = { enabled: true };
  value.audioTracks = [
    {
      slideNumber: 1,
      assetUrl: "/audio",
      storageKey: "workspaces/w/artifacts/a/slide-1.mp3",
      storageBucket: "content",
      durationSeconds: 4,
      mimeType: "audio/mpeg",
      fileName: "slide-1.mp3",
      contentDigest: digest("c"),
      contentType: "audio/mpeg",
    },
  ];
  value.assets = [
    {
      assetId: "hero",
      type: "hero",
      prompt: "Hero",
      fileName: "hero.png",
      storageKey: "workspaces/w/artifacts/a/hero.png",
      storageBucket: "content",
      sourceUrl: "/hero.png",
      slideNumbers: [1],
      source: "generated",
      contentDigest: digest("d"),
      contentType: "image/png",
    },
  ];
  assert.equal(videoPresentationProjectPayloadSchema.safeParse(value).success, true);

  for (const [collection, field] of [
    ["audioTracks", "contentDigest"],
    ["audioTracks", "contentType"],
    ["assets", "contentDigest"],
    ["assets", "contentType"],
  ] as const) {
    const invalid = structuredClone(value) as Record<string, unknown>;
    delete ((invalid[collection] as Array<Record<string, unknown>>)[0]!)[field];
    assert.equal(
      videoPresentationProjectPayloadSchema.safeParse(invalid).success,
      false,
      `${collection}.${field} must be required`,
    );
  }
});

test("renderable project is internal and cannot masquerade as committed", () => {
  const renderable = videoPresentationRenderableProjectSchema.parse({
    ...semanticProject(),
    audioTracks: [],
    assets: [],
    preview: { slideCount: 1, durationSeconds: 5 },
  });
  assert.equal("renderedVideo" in renderable, false);
  assert.equal(
    videoPresentationProjectPayloadSchema.safeParse(renderable).success,
    false,
  );
});
