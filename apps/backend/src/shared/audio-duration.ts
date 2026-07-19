import { logger } from "./logger";

/**
 * Measure the real duration of an audio buffer (e.g. TTS output, uploads).
 *
 * WAV buffers are measured directly from the RIFF header and the actual byte
 * length: streamed TTS WAVs often declare a placeholder data-chunk size, so
 * the declared size cannot be trusted. Other formats go through
 * music-metadata's full-scan mode (streamed MP3 typically has no Xing/Info
 * header, so header-only extrapolation is inaccurate).
 *
 * Returns null (never throws) when the buffer cannot be measured plausibly;
 * callers fall back to a word-count estimate.
 */
export async function probeAudioDurationSeconds(input: {
  buffer: Buffer;
  mimeType: string;
}): Promise<number | null> {
  const wavDuration = wavDurationSeconds(input.buffer);
  if (wavDuration !== null) {
    return plausibleOrNull(wavDuration, input.buffer.byteLength, "wav");
  }
  try {
    const { parseBuffer } = await import("music-metadata");
    const metadata = await parseBuffer(
      input.buffer,
      { mimeType: input.mimeType },
      { duration: true },
    );
    const duration = metadata.format.duration;
    if (
      typeof duration !== "number" ||
      !Number.isFinite(duration) ||
      duration <= 0
    ) {
      return null;
    }
    return plausibleOrNull(duration, input.buffer.byteLength, "metadata");
  } catch (error) {
    logger.warn("audio_duration_probe_failed", {
      mimeType: input.mimeType,
      bufferBytes: input.buffer.byteLength,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// Distrust measurements that imply an absurd byte rate: real speech audio
// sits well under 2 MB/s (even 48kHz stereo 16-bit PCM is ~192 KB/s), and a
// sub-second duration for a large buffer signals a broken container header.
function plausibleOrNull(
  durationSeconds: number,
  bufferBytes: number,
  via: "wav" | "metadata",
) {
  const impliedBytesPerSecond = bufferBytes / durationSeconds;
  if (impliedBytesPerSecond > 2_000_000) {
    logger.warn("audio_duration_probe_implausible", {
      via,
      durationSeconds,
      bufferBytes,
    });
    return null;
  }
  return Number(durationSeconds.toFixed(2));
}

/**
 * Duration of a PCM WAV buffer, computed from the fmt chunk's byte rate and
 * the larger of the declared data size and the bytes actually present after
 * the data chunk header (streamed writers leave placeholder sizes).
 * Returns null when the buffer is not a parseable RIFF/WAVE file.
 */
function wavDurationSeconds(buffer: Buffer): number | null {
  if (
    buffer.byteLength < 44 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WAVE"
  ) {
    return null;
  }
  let offset = 12;
  let byteRate: number | null = null;
  while (offset + 8 <= buffer.byteLength) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const declaredSize = buffer.readUInt32LE(offset + 4);
    const bodyOffset = offset + 8;
    if (chunkId === "fmt ") {
      if (bodyOffset + 12 > buffer.byteLength) {
        return null;
      }
      byteRate = buffer.readUInt32LE(bodyOffset + 8);
    }
    if (chunkId === "data") {
      if (!byteRate || byteRate <= 0) {
        return null;
      }
      const actualBytes = buffer.byteLength - bodyOffset;
      const dataBytes = Math.max(declaredSize, actualBytes);
      if (dataBytes <= 0) {
        return null;
      }
      return dataBytes / byteRate;
    }
    // Chunks are word-aligned; a zero/placeholder size on a non-data chunk
    // would stall the walk, so bail out instead of looping forever.
    const advance = 8 + declaredSize + (declaredSize % 2);
    if (declaredSize === 0 || offset + advance <= offset) {
      return null;
    }
    offset += advance;
  }
  return null;
}
