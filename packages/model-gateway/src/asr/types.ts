/**
 * What one ASR provider can take in a single request. Every transport declares
 * its own, because providers differ widely: OpenAI-style endpoints take any
 * common container up to a size cap, while DeepSeek takes only short PCM WAV.
 */
export type AsrLimits = {
  /** File extensions the provider accepts untouched. Empty = always normalize. */
  readonly acceptedFormats: readonly string[];
  /** Undefined when the provider documents no cap. */
  readonly maxBytes?: number;
  readonly maxDurationSec?: number;
  /** Whether the provider returns segment timestamps of its own. */
  readonly timestamps: "segment" | "none";
  /** Target chunk length when the audio has to be split. */
  readonly chunkSec: number;
  /** Chunk requests in flight for one transcription. */
  readonly maxConcurrent: number;
};

export type AsrAudioSource = {
  readonly audio: Uint8Array;
  readonly fileName: string;
  readonly mimeType?: string;
};

export type AsrSilence = { readonly startSec: number; readonly endSec: number };

/** Audio decoded to mono 16-bit PCM, readable by byte range. */
export interface NormalizedAsrAudio {
  readonly sampleRate: number;
  readonly pcmByteLength: number;
  readonly silences: readonly AsrSilence[];
  readPcm(byteStart: number, byteEnd: number): Promise<Uint8Array>;
  dispose(): Promise<void>;
}

/**
 * Host-provided decoding. The gateway stays free of ffmpeg; the host injects
 * an implementation, the same way it injects `fetch`.
 */
export interface AsrAudioPreparer {
  /** Null when the duration cannot be measured without decoding. */
  probeDurationSec(
    source: AsrAudioSource,
    signal?: AbortSignal,
  ): Promise<number | null>;
  normalize(
    source: AsrAudioSource,
    signal?: AbortSignal,
  ): Promise<NormalizedAsrAudio>;
}
