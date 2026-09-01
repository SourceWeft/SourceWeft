import type { DeliverablePreviewImage } from "@sourceweft/capability-contracts";
import type { VideoPresentationRenderableProject } from "@sourceweft/contracts/video-presentation";
import { ARTIFACT_LIMITS } from "@sourceweft/contracts/artifact-files";
import { sanitizeVideoPresentationFileBase } from "../video-presentation-files";

const STILL_MIME_TYPE = "image/jpeg" as const;

export type VideoPresentationCoverFile = {
  slideNumber: number;
  data: Uint8Array;
  contentType: typeof STILL_MIME_TYPE;
  fileName: string;
  metadata: DeliverablePreviewImage["metadata"];
};

/** Select the lowest-numbered accepted runtime sample as the required cover. */
export function buildCoverFile(input: {
  payload: Pick<VideoPresentationRenderableProject, "project">;
  stills: ReadonlyArray<{ slideNumber: number; data: Uint8Array }>;
}): VideoPresentationCoverFile | null {
  const cover = [...input.stills]
    .sort((left, right) => left.slideNumber - right.slideNumber)
    .find(
      (still) =>
        still.data.byteLength > 0 &&
        still.data.byteLength <= ARTIFACT_LIMITS.previewImageBytes,
    );
  if (!cover) return null;

  const fileName = `${sanitizeVideoPresentationFileBase(input.payload.project.title)}-cover.jpg`;
  return {
    slideNumber: cover.slideNumber,
    data: cover.data,
    contentType: STILL_MIME_TYPE,
    fileName,
    metadata: {
      altText: `Slide ${cover.slideNumber} of ${input.payload.project.title}`,
      byteLength: cover.data.byteLength,
      fileName,
      mimeType: STILL_MIME_TYPE,
    },
  };
}
