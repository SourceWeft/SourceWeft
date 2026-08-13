import type {
  ArtifactAssetLocation,
  ArtifactViewHandler,
  ArtifactViewRecord,
  CreateArtifactViewHandlers,
} from "@sourceweft/contracts";
import { videoPresentationProjectPayloadSchema } from "@sourceweft/contracts/video-presentation";

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

/**
 * The server-rendered mp4, when the sandbox render path produced one. It lives
 * under `payload.renderedVideo` rather than the artifact's top-level
 * `storageKey`, and is the artifact's single downloadable/playable file — so it
 * backs both the named-asset route (narration shares that route) and the
 * host's `resolvePrimaryFile` hook for public shares. Payloads written before
 * the sandbox render path exists simply have no `renderedVideo`.
 */
function resolveRenderedVideoFile(
  artifact: ArtifactViewRecord,
): ArtifactAssetLocation | null {
  const payload = toObjectRecord(artifact.payloadJson);
  const renderedVideo = payload ? toObjectRecord(payload.renderedVideo) : null;
  if (
    !renderedVideo ||
    typeof renderedVideo.storageKey !== "string" ||
    typeof renderedVideo.fileName !== "string"
  ) {
    return null;
  }
  return {
    contentType:
      typeof renderedVideo.mimeType === "string"
        ? renderedVideo.mimeType
        : BINARY_MIME_TYPE,
    fileName: renderedVideo.fileName,
    storageBucket:
      typeof renderedVideo.storageBucket === "string"
        ? renderedVideo.storageBucket
        : artifact.storageBucket,
    storageKey: renderedVideo.storageKey,
  };
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

  const renderedVideo = resolveRenderedVideoFile(artifact);
  if (renderedVideo && renderedVideo.fileName === fileName) {
    return renderedVideo;
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

/**
 * The payload a PUBLIC share hands the browser to client-render the deck — the
 * same path the owner's preview uses. A share is a deliberate grant and the
 * scene code / narration / slide text ARE the shared content, so almost nothing
 * is stripped: schema parsing already drops DB-internal fields (`sourceJson`,
 * `jobId`, source-json URLs) that are not part of the payload shape. Only two
 * things change:
 *   - every asset URL is rewritten to the caller's share-token route so an
 *     anonymous viewer can fetch narration/images (its internal storage keys,
 *     useless to a viewer, are blanked in the same pass);
 *   - `sourceDigest` — the source material, which can exceed what the video
 *     shows — is redacted.
 * Returns null when the payload is not a valid, complete project.
 */
function buildPublicVideoPresentationPayload(input: {
  artifact: ArtifactViewRecord;
  assetUrl: (fileName: string) => string;
}): Record<string, unknown> | null {
  const parsed = videoPresentationProjectPayloadSchema.safeParse(
    input.artifact.payloadJson,
  );
  if (!parsed.success) {
    return null;
  }
  const { assetUrl } = input;
  const payload = parsed.data;
  const assetFileName = (storageKey: string) =>
    storageKey.split("/").pop() ?? storageKey;
  // Scene code can hard-code an asset's sourceUrl (`AssetImage src="…"`); the
  // workspace URL would 404 for an anonymous viewer, so rewrite it too. Only
  // walks the code when there are assets to replace.
  const rewriteAssetUrlsInCode = (code: string) => {
    let rewritten = code;
    for (const asset of payload.assets) {
      if (asset.sourceUrl) {
        rewritten = rewritten
          .split(asset.sourceUrl)
          .join(assetUrl(assetFileName(asset.storageKey)));
      }
    }
    return rewritten;
  };
  return {
    ...payload,
    requestKey: undefined,
    renderedVideo: undefined,
    sourceDigest: "[redacted]",
    audioTracks: payload.audioTracks.map((track) => ({
      ...track,
      assetUrl: assetUrl(track.fileName),
      storageKey: "shared",
      storageBucket: undefined,
    })),
    assets: payload.assets.map((asset) => ({
      ...asset,
      ...(asset.sourceUrl
        ? { sourceUrl: assetUrl(assetFileName(asset.storageKey)) }
        : {}),
      storageKey: "shared",
      storageBucket: undefined,
    })),
    sceneModules: payload.assets.length
      ? payload.sceneModules.map((module) => ({
          ...module,
          code: rewriteAssetUrlsInCode(module.code),
        }))
      : payload.sceneModules,
  };
}

export const videoPresentationArtifactViewHandler: ArtifactViewHandler = {
  artifactType: VIDEO_PRESENTATION_ARTIFACT_TYPE,
  resolveAsset: resolveVideoPresentationAsset,
  // A video presentation has no top-level stored file; when a server-rendered
  // mp4 exists it is the primary file public shares serve and embed.
  resolvePrimaryFile: ({ artifact }) => resolveRenderedVideoFile(artifact),
  // Public shares client-render from this sanitized payload (audio/image URLs
  // rewritten to the share-token asset route); preferred over the mp4 so a deck
  // with no server render is still playable.
  buildPublicPayload: buildPublicVideoPresentationPayload,
};

export const createArtifactViewHandlers: CreateArtifactViewHandlers = () => [
  videoPresentationArtifactViewHandler,
];
