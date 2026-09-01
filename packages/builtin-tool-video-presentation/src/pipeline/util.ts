import {
  extensionForMimeType,
  sanitizeArtifactStorageSegment,
} from "@sourceweft/contracts/artifact-files";
import { VIDEO_PRESENTATION_FILE_BASE_FALLBACK } from "../video-presentation-files";

/** ASCII-only identifier for sandbox paths and generated asset file names. */
export function safeStorageSegment(value: string) {
  return sanitizeArtifactStorageSegment(value, {
    fallback: VIDEO_PRESENTATION_FILE_BASE_FALLBACK,
    maxLength: 80,
  });
}

export function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function imageExtensionForMimeType(mimeType: string | undefined | null) {
  return extensionForMimeType(mimeType, ".jpg");
}
