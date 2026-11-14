import type { AsrSegment, AsrTranscribeResult, UsageInfo } from "../types";
import type { AsrLimits, AsrSilence } from "./types";

const BYTES_PER_SAMPLE = 2;
const WAV_HEADER_BYTES = 44;
/** A cut may move this far from its target to land in a silence. */
export const ASR_SNAP_WINDOW_SEC = 10;

export type AsrChunkSpan = {
  readonly startSec: number;
  readonly endSec: number;
  /**
   * False when the span ends on a cut that found no pause to land in, so it
   * may end in the middle of a sentence or even a word.
   */
  readonly endsInSilence: boolean;
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
 * to the middle of the longest silence within the snap window: a sentence
 * usually ends on a longer pause than the gap inside a phrase, so the longest
 * one is the least likely to split a thought. Equal pauses go to the nearest.
 * With no silence in the window the cut falls on the target and the span is
 * marked as not ending in silence.
 */
export function planAsrChunks(input: {
  durationSec: number;
  chunkSec: number;
  silences: readonly AsrSilence[];
}): AsrChunkSpan[] {
  const { durationSec, chunkSec } = input;
  if (!(durationSec > 0)) return [];
  const pauses = input.silences
    .map((silence) => ({
      mid: (silence.startSec + silence.endSec) / 2,
      length: silence.endSec - silence.startSec,
    }))
    .filter((pause) => pause.mid > 0 && pause.mid < durationSec);

  const spans: AsrChunkSpan[] = [];
  let start = 0;
  while (durationSec - start > chunkSec + ASR_SNAP_WINDOW_SEC) {
    const target = start + chunkSec;
    let best: { mid: number; length: number; distance: number } | undefined;
    for (const pause of pauses) {
      const distance = Math.abs(pause.mid - target);
      if (distance > ASR_SNAP_WINDOW_SEC || pause.mid <= start) continue;
      if (
        !best ||
        pause.length > best.length ||
        (pause.length === best.length && distance < best.distance)
      ) {
        best = { ...pause, distance };
      }
    }
    const cut = best ? best.mid : target;
    spans.push({ startSec: start, endSec: cut, endsInSilence: Boolean(best) });
    start = cut;
  }
  spans.push({ startSec: start, endSec: durationSec, endsInSilence: true });
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
 * A chunk is transcribed as if it were a whole recording, so a model closes it
 * with a full stop even when the cut fell mid-sentence. Where the cut found no
 * pause that full stop was never spoken: drop it. Other punctuation is kept.
 */
function dropAddedFullStop(text: string) {
  return /[^。.][。.]$/u.test(text) ? text.slice(0, -1) : text;
}

/** Latin text needs a space across a hard cut; CJK text does not. */
function hardCutJoiner(before: string, after: string) {
  return /[\p{Script=Latin}\d]$/u.test(before) &&
    /^[\p{Script=Latin}\d]/u.test(after)
    ? " "
    : "";
}

/**
 * Merge per-chunk results into one transcript on the original timeline. A
 * provider's own segments are shifted by the chunk start; a provider without
 * timestamps contributes one segment per chunk. Chunks cut on a pause are
 * joined on a new line; chunks cut mid-speech are joined back into one run.
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
  let joined = "";
  // How the next non-empty chunk attaches to what came before.
  let hardCutPending = false;
  input.results.forEach((result, index) => {
    const span = input.spans[index] as AsrChunkSpan;
    const trimmed = result.text.trim();
    const text = span.endsInSilence ? trimmed : dropAddedFullStop(trimmed);
    if (text) {
      if (!joined) joined = text;
      else if (hardCutPending) joined += hardCutJoiner(joined, text) + text;
      else joined += `\n${text}`;
      hardCutPending = !span.endsInSilence;
    }
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
    text: joined,
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
