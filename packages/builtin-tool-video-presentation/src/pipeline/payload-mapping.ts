import {
  videoPresentationCommittedPayloadSchema,
  videoPresentationDraftPayloadSchema,
  type VideoPresentationCommittedPayload,
  type VideoPresentationCoverImage,
  type VideoPresentationDraftPayload,
  type VideoPresentationDraftResourceRef,
  type VideoPresentationRenderedVideo,
} from "@sourceweft/contracts/video-presentation";

export type CommittedVideoResource = {
  storageKey: string;
  storageBucket: string;
  fileName: string;
  assetUrl: string;
  contentDigest: string;
  contentType: string;
};

export function videoDraftResourceKey(
  resource: VideoPresentationDraftResourceRef,
) {
  return resource.kind === "committed"
    ? `committed:${resource.resourceHandle}`
    : `local:${resource.contentDigest}:${resource.sandboxPath}`;
}

/** Map a frozen, validated draft closure to the permanent browser payload. */
export function draftToCommittedPayload(input: {
  draft: VideoPresentationDraftPayload;
  resources: ReadonlyMap<string, CommittedVideoResource>;
  requestKey: string;
  projectCode: NonNullable<VideoPresentationCommittedPayload["projectCode"]>;
  preview: VideoPresentationCommittedPayload["preview"];
  renderedVideo: VideoPresentationRenderedVideo;
  coverImage: VideoPresentationCoverImage;
}): VideoPresentationCommittedPayload {
  const draft = videoPresentationDraftPayloadSchema.parse(input.draft);
  const usedResourceKeys = new Set<string>();
  const resolveResource = (resource: VideoPresentationDraftResourceRef) => {
    const key = videoDraftResourceKey(resource);
    const committed = input.resources.get(key);
    if (!committed) {
      throw new Error(`VIDEO_RESOURCE_NOT_COMMITTED: ${key}`);
    }
    if (
      committed.contentDigest !== resource.contentDigest ||
      committed.contentType !== resource.contentType
    ) {
      throw new Error(`VIDEO_RESOURCE_COMMIT_MISMATCH: ${key}`);
    }
    usedResourceKeys.add(key);
    return committed;
  };
  const audioTracks = draft.audioTracks.map((track) => {
    const committed = resolveResource(track.resource);
    return {
      slideNumber: track.slideNumber,
      durationSeconds: track.durationSeconds,
      mimeType: track.mimeType,
      contentDigest: committed.contentDigest,
      contentType: committed.contentType,
      fileName: track.fileName,
      assetUrl: committed.assetUrl,
      storageKey: committed.storageKey,
      storageBucket: committed.storageBucket,
    };
  });
  const assets = draft.assets.map((asset) => {
    const committed = resolveResource(asset.resource);
    return {
      assetId: asset.assetId,
      type: asset.type,
      prompt: asset.prompt,
      slideNumbers: asset.slideNumbers,
      source: asset.source,
      fileName: committed.fileName,
      sourceUrl: committed.assetUrl,
      contentDigest: committed.contentDigest,
      contentType: committed.contentType,
      storageKey: committed.storageKey,
      storageBucket: committed.storageBucket,
    };
  });
  const extra = [...input.resources.keys()].filter(
    (key) => !usedResourceKeys.has(key),
  );
  if (extra.length > 0) {
    throw new Error(
      `VIDEO_RESOURCE_COMMIT_UNUSED: ${extra.slice(0, 4).join(", ")}`,
    );
  }
  return videoPresentationCommittedPayloadSchema.parse({
    schemaVersion: 1,
    kind: "video_presentation",
    requestKey: input.requestKey,
    workflowVersion: draft.workflowVersion,
    builderVersion: draft.builderVersion,
    narrationPolicy: draft.narrationPolicy,
    project: draft.project,
    slides: draft.slides,
    audioTracks,
    sceneModules: draft.sceneModules,
    assets,
    preview: input.preview,
    renderedVideo: input.renderedVideo,
    coverImage: input.coverImage,
    renderProfile: draft.renderProfile,
    themeAssignments: draft.themeAssignments,
    sourceDigest: draft.sourceDigest,
    projectCode: input.projectCode,
  });
}
