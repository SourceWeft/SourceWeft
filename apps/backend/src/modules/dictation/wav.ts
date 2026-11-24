import { DICTATION_ERROR_CODES, DICTATION_LIMITS } from "@sourceweft/contracts/dictation";
import { ContentError } from "../content/errors";

const RIFF_HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;
const FMT_CHUNK_MIN_BYTES = 16;
const PCM_FORMAT_TAG = 1;
const REQUIRED_CHANNELS = 1;
const REQUIRED_SAMPLE_RATE = 16000;
const REQUIRED_BITS_PER_SAMPLE = 16;

function invalidAudio(): ContentError {
  return new ContentError(
    400,
    DICTATION_ERROR_CODES.invalidAudio,
    "The recorded segment is not a valid audio file within the dictation limits.",
  );
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let value = "";
  for (let i = 0; i < length; i++) {
    value += String.fromCharCode(bytes[offset + i]!);
  }
  return value;
}

type WavFormat = {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
};

/**
 * Validates a dictation segment upload and reports its duration.
 *
 * Accepts only mono, 16 kHz, 16-bit PCM WAV (the exact format
 * `packages/ui/src/lib/audio/wav.ts` encodes), no longer than
 * `DICTATION_LIMITS.maxSegmentSeconds`. The RIFF chunks are walked rather than
 * read at fixed offsets, so a `fmt ` or `data` chunk after an unrelated chunk
 * (e.g. `LIST`) is still found.
 */
export function readDictationWav(bytes: Uint8Array): { durationSec: number } {
  if (bytes.length < RIFF_HEADER_BYTES) throw invalidAudio();
  if (readAscii(bytes, 0, 4) !== "RIFF") throw invalidAudio();
  if (readAscii(bytes, 8, 4) !== "WAVE") throw invalidAudio();

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let offset = RIFF_HEADER_BYTES;
  let format: WavFormat | null = null;
  let dataSize: number | null = null;

  while (offset + CHUNK_HEADER_BYTES <= bytes.length) {
    const chunkId = readAscii(bytes, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkStart = offset + CHUNK_HEADER_BYTES;

    if (chunkId === "fmt ") {
      if (chunkStart + FMT_CHUNK_MIN_BYTES > bytes.length) throw invalidAudio();
      format = {
        audioFormat: view.getUint16(chunkStart, true),
        channels: view.getUint16(chunkStart + 2, true),
        sampleRate: view.getUint32(chunkStart + 4, true),
        bitsPerSample: view.getUint16(chunkStart + 14, true),
      };
    } else if (chunkId === "data") {
      if (chunkStart + chunkSize > bytes.length) throw invalidAudio();
      dataSize = chunkSize;
      break;
    }

    // Chunks are padded to an even size; skip the pad byte too.
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  if (!format || dataSize === null) throw invalidAudio();
  if (format.audioFormat !== PCM_FORMAT_TAG) throw invalidAudio();
  if (format.channels !== REQUIRED_CHANNELS) throw invalidAudio();
  if (format.sampleRate !== REQUIRED_SAMPLE_RATE) throw invalidAudio();
  if (format.bitsPerSample !== REQUIRED_BITS_PER_SAMPLE) throw invalidAudio();
  if (dataSize <= 0) throw invalidAudio();

  const byteRate =
    format.sampleRate * format.channels * (format.bitsPerSample / 8);
  const durationSec = dataSize / byteRate;

  if (durationSec <= 0 || durationSec > DICTATION_LIMITS.maxSegmentSeconds) {
    throw invalidAudio();
  }

  return { durationSec };
}
