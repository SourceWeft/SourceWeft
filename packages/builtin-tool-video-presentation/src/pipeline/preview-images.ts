import type { DeliverablePreviewImage } from "@sourceweft/capability-contracts";
import type { VideoPresentationProjectPayload } from "@sourceweft/contracts/video-presentation";
import { ARTIFACT_LIMITS } from "@sourceweft/contracts/artifact-files";
import type { VideoPipelineDeps } from "./deps";
import { imageExtensionForMimeType, safeStorageSegment } from "./util";

/** Stills come out of the sandbox as JPEG (see project-code render-stills). */
const STILL_MIME_TYPE = "image/jpeg";

/**
 * Guard against a pathological still blowing up the artifact row. The renderer
 * emits ~100-300KB frames at 1920x1080/q80, so this only trips on corruption.
 */
const MAX_COVER_IMAGE_BYTES = ARTIFACT_LIMITS.previewImageBytes;

/**
 * Upload the lowest-numbered QA still as the artifact thumbnail, mirroring the
 * pptx convention of previewing slide 1. Returns null when no usable still
 * exists — stills are best-effort in the sandbox, so a missing thumbnail is a
 * normal outcome, not a failure.
 */
export async function uploadCoverImage(input: {
  artifactId: string;
  deps: VideoPipelineDeps;
  payload: VideoPresentationProjectPayload;
  stills: ReadonlyArray<{ slideNumber: number; data: Uint8Array }>;
  workspaceId: string;
}): Promise<DeliverablePreviewImage | null> {
  const cover = [...input.stills]
    .sort((left, right) => left.slideNumber - right.slideNumber)
    .find(
      (still) =>
        still.data.byteLength > 0 &&
        still.data.byteLength <= MAX_COVER_IMAGE_BYTES,
    );
  if (!cover) {
    return null;
  }

  const fileName = `${safeStorageSegment(input.payload.project.title)}-cover${imageExtensionForMimeType(STILL_MIME_TYPE)}`;
  const storageKey = input.deps.storage.buildArtifactStorageKey({
    artifactId: input.artifactId,
    fileName,
    workspaceId: input.workspaceId,
  });
  await input.deps.storage.upload({
    body: cover.data,
    contentType: STILL_MIME_TYPE,
    key: storageKey,
  });

  return {
    storageKey,
    metadata: {
      altText: `Slide ${cover.slideNumber} of ${input.payload.project.title}`,
      byteLength: cover.data.byteLength,
      fileName,
      mimeType: STILL_MIME_TYPE,
    },
  };
}
