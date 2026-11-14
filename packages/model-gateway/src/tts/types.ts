/**
 * Host-provided audio conversion for TTS. A provider that cannot produce the
 * requested format synthesizes in a format it does have, and the host converts
 * the result. The gateway stays free of ffmpeg, as with `asrAudioPreparer`.
 */
export interface TtsAudioTranscoder {
  transcode(
    input: {
      readonly audio: Uint8Array;
      /** Container of `audio`, e.g. "wav". */
      readonly fromFormat: string;
      /** Requested output: mp3, opus, aac, flac, wav or pcm. */
      readonly toFormat: string;
    },
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
}
