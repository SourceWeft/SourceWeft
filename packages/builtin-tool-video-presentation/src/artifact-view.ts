import type {
  ArtifactAssetLocation,
  ArtifactVersionMedia,
  ArtifactViewHandler,
  ArtifactViewRecord,
  CreateArtifactViewHandlers,
} from "@sourceweft/contracts";
import { videoPresentationCommittedPayloadSchema } from "@sourceweft/contracts/video-presentation";
import { buildVideoPresentationProjectFileName } from "./video-presentation-files";

/**
 * Read-side takeover for `video_presentation` artifacts.
 *
 * The client only receives an immutable rendered-media projection. Scene source
 * remains available to trusted backend edit/source readers but is never needed
 * for playback.
 */

export const VIDEO_PRESENTATION_ARTIFACT_TYPE = "video_presentation";

function toObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function resolveVideoPresentationVersionMedia(
  artifact: ArtifactViewRecord,
): ArtifactVersionMedia | null {
  const parsed = videoPresentationCommittedPayloadSchema.safeParse(
    artifact.payloadJson,
  );
  if (!parsed.success) return null;
  const payload = toObjectRecord(parsed.data);
  const project = toObjectRecord(payload?.project);
  const rendered = toObjectRecord(payload?.renderedVideo);
  const cover = toObjectRecord(payload?.coverImage);
  const byteLength = positiveNumber(rendered?.byteLength);
  const durationInFrames = positiveNumber(rendered?.durationInFrames);
  const fps = positiveNumber(rendered?.fps);
  const width = positiveNumber(rendered?.width);
  const height = positiveNumber(rendered?.height);
  const coverByteLength = positiveNumber(cover?.byteLength);
  const coverWidth = positiveNumber(cover?.width);
  const coverHeight = positiveNumber(cover?.height);
  if (
    typeof project?.title !== "string" ||
    !rendered ||
    typeof rendered.storageKey !== "string" ||
    typeof rendered.storageBucket !== "string" ||
    typeof rendered.fileName !== "string" ||
    typeof rendered.mimeType !== "string" ||
    typeof rendered.contentDigest !== "string" ||
    !byteLength ||
    !durationInFrames ||
    !fps ||
    !width ||
    !height ||
    !cover ||
    typeof cover.storageKey !== "string" ||
    typeof cover.storageBucket !== "string" ||
    typeof cover.fileName !== "string" ||
    typeof cover.mimeType !== "string" ||
    typeof cover.contentDigest !== "string" ||
    !coverByteLength ||
    !coverWidth ||
    !coverHeight
  ) {
    return null;
  }
  return {
    title: project.title,
    description: null,
    durationSeconds: durationInFrames / fps,
    media: {
      contentType: rendered.mimeType,
      fileName: rendered.fileName,
      storageBucket: rendered.storageBucket,
      storageKey: rendered.storageKey,
      byteLength,
      contentDigest: rendered.contentDigest,
      width,
      height,
      fps,
      hasAudio: rendered.hasAudio === true,
    },
    coverImage: {
      contentType: cover.mimeType,
      fileName: cover.fileName,
      storageBucket: cover.storageBucket,
      storageKey: cover.storageKey,
      byteLength: coverByteLength,
      contentDigest: cover.contentDigest,
      width: coverWidth,
      height: coverHeight,
    },
  };
}

/**
 * Resolve a sub-asset of the artifact by its (already-decoded) served file
 * name — the counterpart to `buildArtifactAssetUrl`, which is what the
 * pipeline writes into every `audioTracks[].assetUrl` and `assets[].sourceUrl`
 * in the committed payload (see `pipeline/payload-mapping.ts`). Without this
 * hook the host's generic `/assets/{fileName}` route has nothing to consult
 * and 404s on every narration track and generated/provided image.
 *
 * The rendered mp4 and cover image are also matched here (in addition to being
 * reachable via `resolveVersionMedia`'s dedicated `/versions/{id}/media`
 * route) because their own `renderedVideo`/`coverImage.fileName` can also be
 * dereferenced through the flat asset route by anything holding just a file
 * name (e.g. scene code that materialized a `sourceweft-asset:` URI back to a
 * served URL — see `pipeline/asset-uris.ts`).
 */
function resolveVideoPresentationAsset(input: {
  artifact: ArtifactViewRecord;
  fileName: string;
}): ArtifactAssetLocation | null {
  const { artifact, fileName } = input;
  const parsed = videoPresentationCommittedPayloadSchema.safeParse(
    artifact.payloadJson,
  );
  if (!parsed.success || !fileName) return null;
  const payload = parsed.data;

  if (payload.renderedVideo.fileName === fileName) {
    return {
      contentType: payload.renderedVideo.mimeType,
      fileName,
      storageBucket: payload.renderedVideo.storageBucket,
      storageKey: payload.renderedVideo.storageKey,
    };
  }
  if (payload.coverImage.fileName === fileName) {
    return {
      contentType: payload.coverImage.mimeType,
      fileName,
      storageBucket: payload.coverImage.storageBucket,
      storageKey: payload.coverImage.storageKey,
    };
  }
  const track = payload.audioTracks.find(
    (candidate) => candidate.fileName === fileName,
  );
  if (track) {
    return {
      contentType: track.contentType,
      fileName,
      storageBucket: track.storageBucket,
      storageKey: track.storageKey,
    };
  }
  const asset = payload.assets.find(
    (candidate) => candidate.fileName === fileName,
  );
  if (asset) {
    return {
      contentType: asset.contentType,
      fileName,
      storageBucket: asset.storageBucket,
      storageKey: asset.storageKey,
    };
  }
  return null;
}

function listVideoPresentationStorageObjects(artifact: ArtifactViewRecord) {
  const parsed = videoPresentationCommittedPayloadSchema.safeParse(
    artifact.payloadJson,
  );
  if (!parsed.success) return [];
  const payload = parsed.data;
  return [
    payload.renderedVideo,
    payload.coverImage,
    ...payload.audioTracks,
    ...payload.assets,
  ].map((resource) => ({
    storageBucket: resource.storageBucket,
    storageKey: resource.storageKey,
  }));
}

export const videoPresentationArtifactViewHandler: ArtifactViewHandler = {
  artifactType: VIDEO_PRESENTATION_ARTIFACT_TYPE,
  resolveVersionMedia: ({ artifact }) =>
    resolveVideoPresentationVersionMedia(artifact),
  listOwnedStorageObjects: ({ artifact }) =>
    listVideoPresentationStorageObjects(artifact),
  resolveAsset: resolveVideoPresentationAsset,
  buildSourceJson: ({ artifact }) => {
    const parsed = videoPresentationCommittedPayloadSchema.safeParse(
      artifact.payloadJson,
    );
    return parsed.success
      ? {
          payload: parsed.data,
          fileName: buildVideoPresentationProjectFileName(
            parsed.data.project.title,
          ),
        }
      : null;
  },
};

export const createArtifactViewHandlers: CreateArtifactViewHandlers = () => [
  videoPresentationArtifactViewHandler,
];
