import type { AsrSegment, AsrTranscribeResult, UsageInfo } from "../types";
import type { AsrLimits, AsrSilence } from "./types";

const BYTES_PER_SAMPLE = 2;
const WAV_HEADER_BYTES = 44;
/** A cut may move this far from its target to land in a silence. */
export const ASR_SNAP_WINDOW_SEC = 5;

export type AsrChunkSpan = {
  readonly startSec: number;
  readonly endSec: number;
};

/**
 * The longest chunk that still fits the provider's caps once a cut has been
 * moved by the snap window.
 */
export function resolveAsrChunkSec(limits: AsrLimits, sampleRate: number) {
  const bytesPerSec = sampleRate * BYTES_PER_SAMPLE;
  const caps = [limits.chunkSec];
  if (limits.maxDurationSec !== undefined) {
    caps.push(limits.maxDurationSec - ASR_SNAP_WINDOW_SEC);
  }
  if (limits.maxBytes !== undefined) {
    caps.push(
      Math.floor((limits.maxBytes - WAV_HEADER_BYTES) / bytesPerSec) -
        ASR_SNAP_WINDOW_SEC,
    );
  }
  return Math.max(1, Math.min(...caps));
}

/**
 * Cut `durationSec` into consecutive spans of about `chunkSec`. Each cut moves
 * to the middle of the nearest silence within the snap window, so a word is
 * not split when a pause is close by; with no silence nearby it cuts on target.
 */
export function planAsrChunks(input: {
  durationSec: number;
  chunkSec: number;
  silences: readonly AsrSilence[];
}): AsrChunkSpan[] {
  const { durationSec, chunkSec } = input;
  if (!(durationSec > 0)) return [];
  const mids = input.silences
    .map((silence) => (silence.startSec + silence.endSec) / 2)
    .filter((mid) => mid > 0 && mid < durationSec);

  const spans: AsrChunkSpan[] = [];
  let start = 0;
  while (durationSec - start > chunkSec + ASR_SNAP_WINDOW_SEC) {
    const target = start + chunkSec;
    let cut = target;
    let best = Number.POSITIVE_INFINITY;
    for (const mid of mids) {
      const distance = Math.abs(mid - target);
      if (distance <= ASR_SNAP_WINDOW_SEC && distance < best) {
        best = distance;
        cut = mid;
      }
    }
    spans.push({ startSec: start, endSec: cut });
    start = cut;
  }
  spans.push({ startSec: start, endSec: durationSec });
  return spans;
}

/** Byte range of a span inside mono 16-bit PCM, aligned to whole samples. */
export function asrSpanToPcmRange(
  span: AsrChunkSpan,
  sampleRate: number,
  pcmByteLength: number,
) {
  const toByte = (sec: number) =>
    Math.min(pcmByteLength, Math.round(sec * sampleRate) * BYTES_PER_SAMPLE);
  return { byteStart: toByte(span.startSec), byteEnd: toByte(span.endSec) };
}

/** Wrap mono 16-bit PCM in a canonical 44-byte RIFF/WAVE header. */
export function buildPcm16WavFile(pcm: Uint8Array, sampleRate: number) {
  const out = new Uint8Array(WAV_HEADER_BYTES + pcm.byteLength);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) {
      out[offset + i] = text.charCodeAt(i);
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true);
  view.setUint16(32, BYTES_PER_SAMPLE, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  out.set(pcm, WAV_HEADER_BYTES);
  return out;
}

const USAGE_SUM_FIELDS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "inputAudioTokens",
  "outputAudioTokens",
] as const satisfies readonly (keyof UsageInfo)[];

function sumUsage(results: readonly AsrTranscribeResult[]) {
  const usage: UsageInfo = {};
  for (const result of results) {
    for (const field of USAGE_SUM_FIELDS) {
      const value = result.usage?.[field];
      if (typeof value === "number") {
        usage[field] = (usage[field] ?? 0) + value;
      }
    }
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/**
 * Merge per-chunk results into one transcript on the original timeline. A
 * provider's own segments are shifted by the chunk start; a provider without
 * timestamps contributes one segment per chunk.
 */
export function stitchAsrChunks(input: {
  spans: readonly AsrChunkSpan[];
  results: readonly AsrTranscribeResult[];
  durationSec: number;
}): AsrTranscribeResult {
  const first = input.results[0];
  if (!first || input.results.length !== input.spans.length) {
    throw new Error("ASR chunk results do not match the chunk plan");
  }

  const segments: AsrSegment[] = [];
  const texts: string[] = [];
  input.results.forEach((result, index) => {
    const span = input.spans[index] as AsrChunkSpan;
    const text = result.text.trim();
    if (text) texts.push(text);
    if (result.segments && result.segments.length > 0) {
      for (const segment of result.segments) {
        segments.push({
          start: segment.start + span.startSec,
          end: Math.min(segment.end + span.startSec, input.durationSec),
          text: segment.text,
        });
      }
    } else if (text) {
      segments.push({ start: span.startSec, end: span.endSec, text });
    }
  });

  const usage = sumUsage(input.results);
  return {
    ...first,
    text: texts.join("\n"),
    duration: input.durationSec,
    inputLengthMs: Math.round(input.durationSec * 1000),
    segments: segments.length > 0 ? segments : undefined,
    words: undefined,
    usage,
    observation: first.observation
      ? { ...first.observation, usage }
      : undefined,
    raw: {
      chunked: true,
      chunkCount: input.results.length,
      chunks: input.results.map((result, index) => ({
        ...(input.spans[index] as AsrChunkSpan),
        raw: result.raw,
      })),
    },
  };
}
