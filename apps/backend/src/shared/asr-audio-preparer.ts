import { mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type {
  AsrAudioPreparer,
  AsrAudioSource,
  AsrSilence,
  NormalizedAsrAudio,
} from "@sourceweft/model-gateway";
import { probeAudioDurationSeconds } from "./audio-duration";
import { ffmpegSemaphore, runFfmpeg } from "./ffmpeg";

/**
 * ffmpeg-backed audio decoding for ASR providers that cannot take an upload
 * as it is (wrong container, too large, too long).
 *
 * One ffmpeg pass decodes the first audio stream to 16 kHz mono 16-bit PCM
 * and reports silences in the same run; chunks are then cut from that PCM by
 * byte range, so ffmpeg never runs a second time. Audio only: `-vn` skips the
 * picture of a video file. The input goes through a temp file because an mp4
 * whose index sits at the end cannot be read from a pipe.
 */
const SAMPLE_RATE = 16_000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const SILENCE_FILTER = "silencedetect=noise=-35dB:d=0.4";

export type FfmpegAsrAudioPreparerOptions = {
  readonly ffmpegPath?: string;
  readonly timeoutMs?: number;
};

/** Reads `silence_start` / `silence_end` pairs out of ffmpeg's log. */
export function parseSilenceLog(log: string): AsrSilence[] {
  const silences: AsrSilence[] = [];
  let start: number | undefined;
  for (const match of log.matchAll(/silence_(start|end): (-?[\d.]+)/g)) {
    const value = Number(match[2]);
    if (!Number.isFinite(value)) continue;
    if (match[1] === "start") {
      start = Math.max(0, value);
    } else if (start !== undefined) {
      if (value > start) silences.push({ startSec: start, endSec: value });
      start = undefined;
    }
  }
  return silences;
}

export function createFfmpegAsrAudioPreparer(
  options: FfmpegAsrAudioPreparerOptions = {},
): AsrAudioPreparer {
  const ffmpegPath = options.ffmpegPath ?? "ffmpeg";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async probeDurationSec(source: AsrAudioSource) {
      return probeAudioDurationSeconds({
        buffer: Buffer.from(
          source.audio.buffer,
          source.audio.byteOffset,
          source.audio.byteLength,
        ),
        mimeType: source.mimeType ?? "application/octet-stream",
      });
    },

    async normalize(
      source: AsrAudioSource,
      signal?: AbortSignal,
    ): Promise<NormalizedAsrAudio> {
      signal?.throwIfAborted();
      const dir = await mkdtemp(join(tmpdir(), "sw-asr-"));
      const dispose = () => rm(dir, { recursive: true, force: true });
      try {
        const extension = /^\.[a-z0-9]{1,5}$/i.test(extname(source.fileName))
          ? extname(source.fileName).toLowerCase()
          : "";
        const inputPath = join(dir, `input${extension}`);
        const pcmPath = join(dir, "audio.pcm");
        await writeFile(inputPath, source.audio);

        const silenceLog = await ffmpegSemaphore.run(() =>
          runFfmpeg({
            ffmpegPath,
            timeoutMs,
            signal,
            keepLines: "silence_",
            args: [
              "-hide_banner",
              "-nostdin",
              "-nostats",
              "-threads",
              "1",
              "-i",
              inputPath,
              "-vn",
              "-map",
              "0:a:0",
              "-af",
              SILENCE_FILTER,
              "-ac",
              "1",
              "-ar",
              String(SAMPLE_RATE),
              "-f",
              "s16le",
              "-acodec",
              "pcm_s16le",
              "-y",
              pcmPath,
            ],
          }),
        );

        const { size } = await stat(pcmPath);
        return {
          sampleRate: SAMPLE_RATE,
          pcmByteLength: size - (size % 2),
          silences: parseSilenceLog(silenceLog),
          async readPcm(byteStart, byteEnd) {
            const length = Math.max(0, byteEnd - byteStart);
            const buffer = Buffer.alloc(length);
            const handle = await open(pcmPath, "r");
            try {
              const { bytesRead } = await handle.read(
                buffer,
                0,
                length,
                byteStart,
              );
              return new Uint8Array(
                buffer.buffer,
                buffer.byteOffset,
                bytesRead,
              );
            } finally {
              await handle.close();
            }
          },
          dispose,
        };
      } catch (error) {
        await dispose();
        throw error;
      }
    },
  };
}

export const ffmpegAsrAudioPreparer = createFfmpegAsrAudioPreparer();
