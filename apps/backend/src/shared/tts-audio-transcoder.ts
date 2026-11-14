import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TtsAudioTranscoder } from "@sourceweft/model-gateway";
import { ffmpegSemaphore, runFfmpeg } from "./ffmpeg";

/**
 * Converts synthesized speech for TTS providers that cannot output the
 * requested format (DeepSeek speaks only WAV and PCM). The provider's own
 * sample rate and channel count are kept; only the encoding changes.
 */
const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;

/** ffmpeg output arguments and file extension per requested format. */
const OUTPUTS: Record<string, { extension: string; args: string[] }> = {
  mp3: { extension: "mp3", args: ["-c:a", "libmp3lame", "-b:a", "128k"] },
  opus: { extension: "ogg", args: ["-c:a", "libopus", "-b:a", "48k"] },
  aac: {
    extension: "aac",
    args: ["-c:a", "aac", "-b:a", "128k", "-f", "adts"],
  },
  flac: { extension: "flac", args: ["-c:a", "flac"] },
  wav: { extension: "wav", args: ["-c:a", "pcm_s16le"] },
  pcm: { extension: "pcm", args: ["-c:a", "pcm_s16le", "-f", "s16le"] },
};

export function createFfmpegTtsAudioTranscoder(
  options: { ffmpegPath?: string; timeoutMs?: number } = {},
): TtsAudioTranscoder {
  const ffmpegPath = options.ffmpegPath ?? "ffmpeg";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async transcode(input, signal) {
      const output = OUTPUTS[input.toFormat.toLowerCase()];
      if (!output) {
        throw new Error(
          `Cannot convert speech to '${input.toFormat}'. Supported: ${Object.keys(OUTPUTS).join(", ")}`,
        );
      }
      const fromExtension = /^[a-z0-9]{1,5}$/i.test(input.fromFormat)
        ? input.fromFormat.toLowerCase()
        : "bin";
      signal?.throwIfAborted();
      const dir = await mkdtemp(join(tmpdir(), "sw-tts-"));
      try {
        const inputPath = join(dir, `input.${fromExtension}`);
        const outputPath = join(dir, `output.${output.extension}`);
        await writeFile(inputPath, input.audio);
        await ffmpegSemaphore.run(() =>
          runFfmpeg({
            ffmpegPath,
            timeoutMs,
            signal,
            args: [
              "-hide_banner",
              "-nostdin",
              "-nostats",
              "-threads",
              "1",
              "-i",
              inputPath,
              "-vn",
              ...output.args,
              "-y",
              outputPath,
            ],
          }),
        );
        return new Uint8Array(await readFile(outputPath));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

export const ffmpegTtsAudioTranscoder = createFfmpegTtsAudioTranscoder();
