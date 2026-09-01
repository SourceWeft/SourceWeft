import {
  extensionForMimeType as artifactExtensionForMimeType,
  sniffAudioMimeType,
} from "@sourceweft/contracts/artifact-files";

/** Extension (with leading dot) for a measured narration container. */
export function extensionForMimeType(mimeType: string | undefined | null) {
  return artifactExtensionForMimeType(mimeType, ".mp3");
}

/** Trust the actual bytes before a provider's declared audio MIME type. */
export function resolveSynthesizedAudioMimeType(input: {
  audio: Uint8Array;
  mimeType?: string | null;
}) {
  return sniffAudioMimeType(input.audio) ?? (input.mimeType || "audio/mpeg");
}
