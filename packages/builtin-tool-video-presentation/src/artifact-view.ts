import type {
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
