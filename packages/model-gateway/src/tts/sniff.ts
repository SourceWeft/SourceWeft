/**
 * The format speech audio really is, from its first bytes. Providers do not
 * always return what was asked for, or label it correctly: one returns WAV for
 * an mp3 request under an `audio/mpeg` header.
 *
 * Only containers with an unambiguous signature are reported. ADTS AAC shares
 * MP3's sync word and raw PCM has no signature, so neither is guessed.
 */
export type SniffedTtsFormat = "wav" | "mp3" | "opus" | "flac";

export function sniffTtsAudioFormat(
  bytes: Uint8Array,
): SniffedTtsFormat | undefined {
  if (bytes.byteLength < 4) return undefined;
  const tag = (offset: number, length: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (bytes.byteLength >= 12 && tag(0, 4) === "RIFF" && tag(8, 4) === "WAVE") {
    return "wav";
  }
  if (tag(0, 4) === "fLaC") return "flac";
  // Speech in an Ogg container is Opus for every provider the gateway serves.
  if (tag(0, 4) === "OggS") return "opus";
  if (tag(0, 3) === "ID3") return "mp3";
  const second = bytes[1] as number;
  // MPEG audio frame sync (11 bits) with a layer field other than 00.
  if (bytes[0] === 0xff && (second & 0xe0) === 0xe0 && (second & 0x06) !== 0) {
    return "mp3";
  }
  return undefined;
}
