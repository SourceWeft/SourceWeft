import { guessAsrAudioFormat } from "../adapters/asr-utils";
import { ModelGatewayError, normalizeGatewayError } from "../errors";
import type { AsrTranscribeInput, AsrTranscribeResult } from "../types";
import {
  asrSpanToPcmRange,
  buildPcm16WavFile,
  planAsrChunks,
  resolveAsrChunkSec,
  stitchAsrChunks,
  type AsrChunkSpan,
} from "./chunking";
import type {
  AsrAudioPreparer,
  AsrAudioSource,
  AsrLimits,
  NormalizedAsrAudio,
} from "./types";

export type AsrExecuteOne = (
  payload: AsrTranscribeInput,
  signal: AbortSignal | undefined,
) => Promise<AsrTranscribeResult>;

async function toBytes(audio: AsrTranscribeInput["audio"]) {
  if (audio instanceof Uint8Array) return audio;
  if (audio instanceof ArrayBuffer) return new Uint8Array(audio);
  return new Uint8Array(await audio.arrayBuffer());
}

function baseNameOf(fileName: string) {
  const name = fileName.split(/[\\/]/).at(-1) ?? fileName;
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(0, dot) : name) || "audio";
}

function clock(sec: number) {
  const total = Math.floor(sec);
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
) {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, limit), items.length) },
    async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await task(items[index] as T, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/**
 * Transcribe within one provider's limits. Audio the provider can take as it
 * is goes through untouched; anything else is decoded once to PCM, cut into
 * chunks that fit, transcribed chunk by chunk and stitched back onto the
 * original timeline. A failed chunk fails the whole call: a transcript with a
 * hole in it is never returned.
 */
export async function transcribeWithinAsrLimits(input: {
  limits: AsrLimits;
  payload: AsrTranscribeInput;
  preparer?: AsrAudioPreparer;
  provider: string;
  signal?: AbortSignal;
  executeOne: AsrExecuteOne;
}): Promise<AsrTranscribeResult> {
  const { limits, payload, preparer, provider } = input;
  const audio = await toBytes(payload.audio);
  const source: AsrAudioSource = {
    audio,
    fileName: payload.fileName,
    mimeType: payload.mimeType,
  };

  const extension = guessAsrAudioFormat(payload);
  let reason: string | undefined;
  if (!extension || !limits.acceptedFormats.includes(extension)) {
    reason = `the provider does not accept ${extension ? `.${extension}` : "this"} audio`;
  } else if (
    limits.maxBytes !== undefined &&
    audio.byteLength > limits.maxBytes
  ) {
    reason = `the file is larger than the provider's ${limits.maxBytes} byte limit`;
  } else if (limits.maxDurationSec !== undefined && preparer) {
    // Without a preparer the duration cannot be measured, so the file goes to
    // the provider as it is and the provider decides, as it always has.
    const duration = await preparer.probeDurationSec(source, input.signal);
    if (duration === null || duration > limits.maxDurationSec) {
      reason = `the audio is longer than the provider's ${limits.maxDurationSec}s limit`;
    }
  }

  if (!reason) {
    return input.executeOne({ ...payload, audio }, input.signal);
  }

  if (!preparer) {
    // A host without audio decoding keeps the old behaviour for providers
    // that take files directly: the transport and the provider judge the file.
    if (limits.acceptedFormats.length > 0) {
      return input.executeOne({ ...payload, audio }, input.signal);
    }
    throw new ModelGatewayError({
      code: "CONFIGURATION",
      message: `ASR provider '${provider}' needs audio decoding (ffmpeg) for '${payload.fileName}' because ${reason}, and no audio preparer is configured`,
      retryable: false,
      provider,
    });
  }
  if (payload.timestampGranularities?.includes("word")) {
    throw new ModelGatewayError({
      code: "BAD_REQUEST",
      message: `Word timestamps are not available for '${payload.fileName}' on ASR provider '${provider}' because ${reason} and the audio has to be split`,
      retryable: false,
      provider,
    });
  }

  let normalized: NormalizedAsrAudio | undefined;
  const abort = new AbortController();
  const onAbort = () => abort.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    input.signal?.throwIfAborted();
    normalized = await preparer.normalize(source, abort.signal);
    const prepared = normalized;
    const durationSec = prepared.pcmByteLength / 2 / prepared.sampleRate;
    const spans = planAsrChunks({
      durationSec,
      chunkSec: resolveAsrChunkSec(limits, prepared.sampleRate),
      silences: prepared.silences,
    });
    if (spans.length === 0) {
      throw new ModelGatewayError({
        code: "BAD_REQUEST",
        message: `'${payload.fileName}' contains no audio to transcribe`,
        retryable: false,
        provider,
      });
    }

    const baseName = baseNameOf(payload.fileName);
    const results = await mapWithConcurrency(
      spans,
      limits.maxConcurrent,
      async (span: AsrChunkSpan, index) => {
        abort.signal.throwIfAborted();
        const { byteStart, byteEnd } = asrSpanToPcmRange(
          span,
          prepared.sampleRate,
          prepared.pcmByteLength,
        );
        const pcm = await prepared.readPcm(byteStart, byteEnd);
        try {
          return await input.executeOne(
            {
              ...payload,
              audio: buildPcm16WavFile(pcm, prepared.sampleRate),
              fileName: `${baseName}.part-${String(index + 1).padStart(3, "0")}.wav`,
              mimeType: "audio/wav",
            },
            abort.signal,
          );
        } catch (error) {
          if (input.signal?.aborted) throw error;
          const cause = normalizeGatewayError(error);
          abort.abort(cause);
          throw new ModelGatewayError({
            code: cause.code,
            message: `ASR chunk ${index + 1}/${spans.length} (${clock(span.startSec)}-${clock(span.endSec)}) failed: ${cause.message}`,
            retryable: cause.retryable,
            statusCode: cause.statusCode,
            provider: cause.provider ?? provider,
            requestId: cause.requestId,
            cause,
          });
        }
      },
    );

    return stitchAsrChunks({ spans, results, durationSec });
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
    await normalized?.dispose();
  }
}
