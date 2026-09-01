import assert from "node:assert/strict";
import test from "node:test";
import {
  VIDEO_PRESENTATION_WORKFLOW_VERSION,
  videoPresentationDraftPayloadSchema,
} from "@sourceweft/contracts/video-presentation";
import {
  draftToCommittedPayload,
  videoDraftResourceKey,
} from "../src/pipeline/payload-mapping";

const localResource = {
  kind: "local" as const,
  sandboxPath: "/workspace/video/audio/slide-1.mp3",
  blobRef: "wip-audio",
  contentDigest: `sha256:${"c".repeat(64)}`,
  contentType: "audio/mpeg",
};

const draft = videoPresentationDraftPayloadSchema.parse({
  schemaVersion: 1,
  kind: "video_presentation_draft",
  workflowVersion: VIDEO_PRESENTATION_WORKFLOW_VERSION,
  builderVersion: "remotion-project",
  narrationPolicy: { enabled: true },
  renderProfile: {
    stylePreset: "technical",
    visualDensity: "balanced",
    durationTarget: "short",
    language: "en",
  },
  sourceDigest: "source",
  project: {
    title: "Mapped video",
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
  audioTracks: [
    {
      slideNumber: 1,
      durationSeconds: 4,
      mimeType: "audio/mpeg",
      fileName: "slide-1.mp3",
      resource: localResource,
    },
  ],
  assets: [],
  themeAssignments: [],
});

const projectCode = {
  install: { ok: true, diagnostics: [] },
  typecheck: { ok: true, diagnostics: [] },
  smoke: { checked: true, ok: true, diagnostics: [] },
};

const committedMedia = {
  renderedVideo: {
    assetUrl: "/artifacts/a/video.mp4",
    storageKey: "workspaces/w/artifacts/a/video.mp4",
    storageBucket: "content",
    fileName: "video.mp4",
    mimeType: "video/mp4" as const,
    byteLength: 1024,
    contentDigest: `sha256:${"a".repeat(64)}`,
    durationInFrames: 150,
    fps: 30,
    width: 1920,
    height: 1080,
    hasAudio: true,
  },
  coverImage: {
    assetUrl: "/artifacts/a/cover.jpg",
    storageKey: "workspaces/w/artifacts/a/cover.jpg",
    storageBucket: "content",
    fileName: "cover.jpg",
    mimeType: "image/jpeg" as const,
    byteLength: 512,
    contentDigest: `sha256:${"b".repeat(64)}`,
    width: 1920,
    height: 1080,
    slideNumber: 1,
    metadata: { altText: "Cover" },
  },
};

test("draft mapper uses only host-issued permanent resource refs", () => {
  const payload = draftToCommittedPayload({
    ...committedMedia,
    draft,
    requestKey: "request-1",
    projectCode,
    preview: { slideCount: 1, durationSeconds: 5 },
    resources: new Map([
      [
        videoDraftResourceKey(localResource),
        {
          storageKey: "workspaces/w/artifacts/a/slide-1.mp3",
          storageBucket: "content",
          fileName: "slide-1.mp3",
          assetUrl: "/artifacts/a/assets/slide-1.mp3",
          contentDigest: localResource.contentDigest,
          contentType: localResource.contentType,
        },
      ],
    ]),
  });

  assert.equal(payload.audioTracks[0]?.storageBucket, "content");
  assert.equal(
    payload.audioTracks[0]?.contentDigest,
    localResource.contentDigest,
  );
  assert.equal(payload.audioTracks[0]?.contentType, localResource.contentType);
  assert.equal(
    payload.audioTracks[0]?.assetUrl,
    "/artifacts/a/assets/slide-1.mp3",
  );
  assert.equal("resource" in payload.audioTracks[0]!, false);
});

test("draft mapper persists immutable digest and content type for visual assets", () => {
  const assetResource = {
    kind: "local" as const,
    sandboxPath: "/workspace/video/public/assets/hero.png",
    blobRef: "wip-hero",
    contentDigest: `sha256:${"d".repeat(64)}`,
    contentType: "image/png",
  };
  const withAsset = videoPresentationDraftPayloadSchema.parse({
    ...draft,
    assets: [
      {
        assetId: "hero",
        type: "hero",
        prompt: "Hero",
        slideNumbers: [1],
        source: "generated",
        resource: assetResource,
      },
    ],
  });
  const payload = draftToCommittedPayload({
    ...committedMedia,
    draft: withAsset,
    requestKey: "request-with-asset",
    projectCode,
    preview: { slideCount: 1, durationSeconds: 5 },
    resources: new Map([
      [
        videoDraftResourceKey(localResource),
        {
          storageKey: "workspaces/w/artifacts/a/slide-1.mp3",
          storageBucket: "content",
          fileName: "slide-1.mp3",
          assetUrl: "/audio",
          contentDigest: localResource.contentDigest,
          contentType: localResource.contentType,
        },
      ],
      [
        videoDraftResourceKey(assetResource),
        {
          storageKey: "workspaces/w/artifacts/a/hero.png",
          storageBucket: "content",
          fileName: "hero.png",
          assetUrl: "/hero.png",
          contentDigest: assetResource.contentDigest,
          contentType: assetResource.contentType,
        },
      ],
    ]),
  });

  assert.equal(payload.assets[0]?.contentDigest, assetResource.contentDigest);
  assert.equal(payload.assets[0]?.contentType, assetResource.contentType);
});

test("draft mapper rejects missing, mismatched, and unused resource commits", () => {
  assert.throws(
    () =>
      draftToCommittedPayload({
        ...committedMedia,
        draft,
        requestKey: "request-1",
        projectCode,
        preview: { slideCount: 1, durationSeconds: 5 },
        resources: new Map(),
      }),
    /VIDEO_RESOURCE_NOT_COMMITTED/,
  );
  const key = videoDraftResourceKey(localResource);
  assert.throws(
    () =>
      draftToCommittedPayload({
        ...committedMedia,
        draft,
        requestKey: "request-1",
        projectCode,
        preview: { slideCount: 1, durationSeconds: 5 },
        resources: new Map([
          [
            key,
            {
              storageKey: "key",
              storageBucket: "content",
              fileName: "slide-1.mp3",
              assetUrl: "/asset",
              contentDigest: "wrong",
              contentType: "audio/mpeg",
            },
          ],
        ]),
      }),
    /VIDEO_RESOURCE_COMMIT_MISMATCH/,
  );
});
