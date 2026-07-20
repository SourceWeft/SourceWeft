import type {
  ArtifactAssetLocation,
  ArtifactViewHandler,
  ArtifactViewRecord,
  CreateArtifactViewHandlers,
} from "@sourceweft/contracts";

/**
 * Read-side takeover for `video_presentation` artifacts.
 *
 * A video presentation has no single downloadable file: the client plays it by
 * rendering the project payload and streaming the per-scene assets. Registering
 * this handler is what tells the host the generic file fallback does not apply
 * here; the payload shape below (audio tracks, scene assets) stays private to
 * this package.
 */

export const VIDEO_PRESENTATION_ARTIFACT_TYPE = "video_presentation";

const BINARY_MIME_TYPE = "application/octet-stream";

function toObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function resolveVideoPresentationAsset(input: {
  artifact: ArtifactViewRecord;
  fileName: string;
}): ArtifactAssetLocation | null {
  const { artifact, fileName } = input;
  const payload = toObjectRecord(artifact.payloadJson);
  if (!payload || !fileName) {
    return null;
  }

  // A server-rendered mp4, when one exists, is served from the same asset
  // route as narration. Payloads written before the sandbox render path exists
  // simply have no `renderedVideo`, so this branch never matches for them.
  const renderedVideo = toObjectRecord(payload.renderedVideo);
  if (
    renderedVideo &&
    renderedVideo.fileName === fileName &&
    typeof renderedVideo.storageKey === "string"
  ) {
    return {
      contentType:
        typeof renderedVideo.mimeType === "string"
          ? renderedVideo.mimeType
          : BINARY_MIME_TYPE,
      fileName,
      storageBucket:
        typeof renderedVideo.storageBucket === "string"
          ? renderedVideo.storageBucket
          : artifact.storageBucket,
      storageKey: renderedVideo.storageKey,
    };
  }

  const audioTracks = Array.isArray(payload.audioTracks)
    ? payload.audioTracks
    : [];
  for (const track of audioTracks) {
    const record = toObjectRecord(track);
    if (
      record &&
      record.fileName === fileName &&
      typeof record.storageKey === "string"
    ) {
      return {
        contentType:
          typeof record.mimeType === "string"
            ? record.mimeType
            : BINARY_MIME_TYPE,
        fileName,
        storageBucket:
          typeof record.storageBucket === "string"
            ? record.storageBucket
            : artifact.storageBucket,
        storageKey: record.storageKey,
      };
    }
  }

  const assets = Array.isArray(payload.assets) ? payload.assets : [];
  for (const asset of assets) {
    const record = toObjectRecord(asset);
    const candidateFileName =
      typeof record?.fileName === "string"
        ? record.fileName
        : typeof record?.storageKey === "string"
          ? record.storageKey.split("/").pop()
          : null;
    if (
      record &&
      candidateFileName === fileName &&
      typeof record.storageKey === "string" &&
      !record.storageKey.startsWith("external:")
    ) {
      return {
        contentType: BINARY_MIME_TYPE,
        fileName,
        storageBucket:
          typeof record.storageBucket === "string"
            ? record.storageBucket
            : artifact.storageBucket,
        storageKey: record.storageKey,
      };
    }
  }

  return null;
}

export const videoPresentationArtifactViewHandler: ArtifactViewHandler = {
  artifactType: VIDEO_PRESENTATION_ARTIFACT_TYPE,
  resolveAsset: resolveVideoPresentationAsset,
};

export const createArtifactViewHandlers: CreateArtifactViewHandlers = () => [
  videoPresentationArtifactViewHandler,
];
